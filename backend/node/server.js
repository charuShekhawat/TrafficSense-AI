const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Larger limit for bbox arrays

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const LANES = ['north', 'east', 'south', 'west'];

// Global State
let systemState = {
  mode: 'AI', // 'AI' or 'STATIC'
  weather: 'Clear', // 'Clear' or 'Rain'
  emergency: false,
  events: [],
  control: null,
  lanes: {
    north: { vehicles: 0, ambulance: false, signal: 'RED', time: 0, boxes: [], ambulanceBoxes: [] },
    east:  { vehicles: 0, ambulance: false, signal: 'RED', time: 0, boxes: [], ambulanceBoxes: [] },
    south: { vehicles: 0, ambulance: false, signal: 'RED', time: 0, boxes: [], ambulanceBoxes: [] },
    west:  { vehicles: 0, ambulance: false, signal: 'RED', time: 0, boxes: [], ambulanceBoxes: [] }
  }
};

// Internal engine tracking
let engine = {
  activeLane: 'north',
  phase: 'GREEN', // 'GREEN' | 'YELLOW' | 'ALL_RED'
  timer: 30, // seconds remaining in current phase
  ambulanceHistory: { north: 0, east: 0, south: 0, west: 0 },
  ambulanceConfirmation: { north: 0, east: 0, south: 0, west: 0 },
  laneIdleTimer: { north: 0, east: 0, south: 0, west: 0 },
  ambulanceQueue: [],
  ambulanceActiveLane: null,
  pendingAmbulanceLane: null, // Lane waiting for GREEN after yellow transition
  prevVehicles: { north: 0, east: 0, south: 0, west: 0 },
  lastPingTime: Date.now()
};

// Raw detection data populated by Python script (now includes boxes)
let detections = {
  north: { vehicles: 0, ambulance: false, confidence: 0.0, boxes: [], ambulanceBoxes: [] },
  east:  { vehicles: 0, ambulance: false, confidence: 0.0, boxes: [], ambulanceBoxes: [] },
  south: { vehicles: 0, ambulance: false, confidence: 0.0, boxes: [], ambulanceBoxes: [] },
  west:  { vehicles: 0, ambulance: false, confidence: 0.0, boxes: [], ambulanceBoxes: [] },
  weather: 'Clear'
};

const reportDirectory = path.join(process.env.LOCALAPPDATA || os.homedir(), 'TrafficSenseAi');
const reportHistory = path.join(reportDirectory, 'signal-decisions.jsonl');
const sessionStarted = new Date().toISOString();
let eventSequence = 0;
let reportError = false;
const laneName = lane => lane.charAt(0).toUpperCase() + lane.slice(1);
function recordDecision(category, message) {
  const event = { id: ++eventSequence, timestamp: Date.now(), category, message };
  systemState.events.unshift(event);
  systemState.events = systemState.events.slice(0, 20);
  const entry = {
    ...event, sessionStarted, mode: systemState.mode, weather: systemState.weather,
    activeLane: engine.phase === 'ALL_RED' ? '' : engine.activeLane,
    phase: engine.phase, remainingSeconds: engine.timer,
    vehicles: Object.fromEntries(LANES.map(lane => [lane, detections[lane].vehicles])),
  };
  try {
    fs.mkdirSync(reportDirectory, { recursive: true });
    fs.appendFileSync(reportHistory, JSON.stringify(entry) + '\n', 'utf8');
  } catch (error) {
    reportError = true;
    console.error('Could not save signal decision:', error.message);
  }
}

function recordSignalChange(previousLane, previousPhase) {
  if (previousLane === engine.activeLane && previousPhase === engine.phase) return;
  const signal = engine.phase === 'ALL_RED'
    ? 'All lanes are RED'
    : `${laneName(engine.activeLane)} is ${engine.phase}; all other lanes are RED`;
  recordDecision('SIGNAL', `${signal}.`);
}

recordDecision('SYSTEM', 'Controller started. Waiting for live traffic detections.');

// Start logic loop (1 second tick)
setInterval(() => {
  const { activeLane, phase } = engine;
  // Sync weather from detections
  systemState.weather = detections.weather || 'Clear';

  if (systemState.mode === 'STATIC') {
    handleStaticMode();
  } else {
    handleAiMode();
  }

  recordSignalChange(activeLane, phase);

  // Map internal engine data to external state
  updateExternalState();

  io.emit('state_update', {
    north: systemState.lanes.north,
    east: systemState.lanes.east,
    south: systemState.lanes.south,
    west: systemState.lanes.west,
    weather: systemState.weather,
    mode: systemState.mode,
    emergency: systemState.emergency,
    control: systemState.control,
    events: systemState.events
  });
}, 1000);

function handleStaticMode() {
  if (engine.timer === null) {
    engine.timer = 30;
    systemState.emergency = false;
    engine.ambulanceActiveLane = null;
    engine.pendingAmbulanceLane = null;
  }
  // Graceful recovery from AI crash states
  if (engine.phase === 'ALL_RED') {
    engine.phase = 'GREEN';
    engine.timer = 30;
    engine.activeLane = 'north';
    return;
  }

  engine.timer--;

  if (engine.phase === 'GREEN' && engine.timer <= 3 && engine.timer > 0) {
    engine.phase = 'YELLOW';
  }

  if (engine.timer <= 0) {
    engine.activeLane = getNextLane(engine.activeLane);
    engine.phase = 'GREEN';
    engine.timer = 30;
  }
}

function handleAiMode() {
  // SENSOR FAILURE CHECK
  if (Date.now() - engine.lastPingTime > 10000) {
     console.log("Sensor failure detected (10s no ping). Switching to STATIC mode.");

     systemState.mode = 'STATIC';
     recordDecision('SYSTEM', 'Detection updates have stopped. Switching to fixed-time STATIC control.');
     return handleStaticMode();
  }

  // UPDATE IDLE TIMERS
  for (let l of LANES) {
    if (engine.phase === 'GREEN' && engine.activeLane === l) {
      engine.laneIdleTimer[l] = 0;
    } else if (detections[l].vehicles > 0) {
      engine.laneIdleTimer[l]++;
    } else {
      engine.laneIdleTimer[l] = 0;
    }
  }

  // AI STEP 1: AMBULANCE PRIORITY (With 2-frame confirmation)
  let activeAmbulances = [];
  for (let l of LANES) {
    if (detections[l].ambulance) {
      engine.ambulanceConfirmation[l]++;
      if (engine.ambulanceConfirmation[l] >= 2) {
        activeAmbulances.push({ lane: l, conf: detections[l].confidence });
      }
      engine.ambulanceHistory[l] = 0;
    } else {
      engine.ambulanceHistory[l]++;
      engine.ambulanceConfirmation[l] = 0;
    }
  }

  // ─── HANDLE PENDING AMBULANCE (waiting for yellow to finish) ───
  if (engine.pendingAmbulanceLane && !detections[engine.pendingAmbulanceLane].ambulance) {
    recordDecision('AMBULANCE', `${laneName(engine.pendingAmbulanceLane)} ambulance detection changed to NO before priority started. Completing the current YELLOW transition and returning to normal scheduling.`);
    engine.pendingAmbulanceLane = null;
  }
  if (engine.pendingAmbulanceLane) {
    engine.timer--;
    if (engine.timer <= 0) {
      // Yellow finished → switch to ambulance lane as GREEN
      engine.activeLane = engine.pendingAmbulanceLane;
      engine.ambulanceActiveLane = engine.pendingAmbulanceLane;
      engine.pendingAmbulanceLane = null;
      systemState.emergency = true;
      engine.phase = 'GREEN';
      engine.timer = null; // Detection-controlled GREEN; no countdown.
      recordDecision('AMBULANCE', `${laneName(engine.activeLane)} is now GREEN for ambulance priority. All other lanes are RED.`);
      console.log(`🚑 Ambulance GREEN activated for ${engine.activeLane}`);
    }
    return;
  }

  // ─── CHECK IF CURRENT EMERGENCY LANE LOST AMBULANCE ───
  if (systemState.emergency) {
    if (!detections[engine.ambulanceActiveLane].ambulance) {
      // Emergency over → go YELLOW 3s, then restart round-robin from ambulance lane
      recordDecision('AMBULANCE', `${laneName(engine.activeLane)} ambulance priority ended: ambulance detection changed to NO. This lane changes to YELLOW for 3 seconds, then normal scheduling resumes.`);
      systemState.emergency = false;
      // activeLane stays as ambulanceActiveLane so round-robin continues from here
      engine.activeLane = engine.ambulanceActiveLane;
      engine.ambulanceActiveLane = null;
      engine.phase = 'YELLOW';
      engine.timer = 3;
      console.log(`🚑 Emergency ended. Yellow transition from ${engine.activeLane}, round-robin resumes after.`);
      return;
    } else {
      // Emergency still active — keep ambulance lane GREEN
      engine.phase = 'GREEN';
      engine.activeLane = engine.ambulanceActiveLane;
      engine.timer = null; // Detection-controlled GREEN; no countdown.
      return; 
    }
  }

  // ─── NEW AMBULANCE DETECTED → trigger YELLOW transition first ───
  if (activeAmbulances.length > 0 && !systemState.emergency) {
    activeAmbulances.sort((a, b) => b.conf - a.conf);
    let targetAmbulance = activeAmbulances[0].lane;

    // If ambulance is already in the current green lane, just activate emergency directly
    if (targetAmbulance === engine.activeLane && engine.phase === 'GREEN') {
      recordDecision('AMBULANCE', `Ambulance confirmed in ${laneName(targetAmbulance)}. This lane is already GREEN; priority is maintained and all other lanes remain RED.`);
      systemState.emergency = true;
      engine.ambulanceActiveLane = targetAmbulance;
      engine.phase = 'GREEN';
      engine.timer = null; // Detection-controlled GREEN; no countdown.
      console.log(`🚑 Ambulance detected in current GREEN lane: ${targetAmbulance}`);
      return;
    }

    // Ambulance in a different lane → current lane goes YELLOW(3s) first
    recordDecision('AMBULANCE', `Ambulance confirmed in ${laneName(targetAmbulance)}. ${laneName(engine.activeLane)} changes to YELLOW for 3 seconds, then RED. ${laneName(targetAmbulance)} will receive GREEN priority.`);
    engine.pendingAmbulanceLane = targetAmbulance;
    engine.phase = 'YELLOW';
    engine.timer = 3;
    console.log(`🚑 Ambulance detected in ${targetAmbulance}. Current lane ${engine.activeLane} → YELLOW (3s)`);
    return;
  }

  // ─── NORMAL AI MODE TICK ───
  engine.timer--;

  // Traffic Spike Adjustment
  if (engine.phase === 'GREEN') {
     let currentDiff = detections[engine.activeLane].vehicles - engine.prevVehicles[engine.activeLane];
     if (currentDiff >= 5 && engine.timer < 10) {
        engine.timer += 5;
        recordDecision('DENSITY', `${laneName(engine.activeLane)} traffic increased by ${currentDiff} vehicles to ${detections[engine.activeLane].vehicles}. GREEN extended by 5 seconds.`);
        console.log(`Traffic Spike Detected in ${engine.activeLane}, adding 5 secs.`);
     }
  }

  if (engine.timer <= 0) {
    if (engine.phase === 'GREEN') {
      // GREEN → YELLOW (always 3 seconds)
      engine.phase = 'YELLOW';
      engine.timer = 3;
    } else if (engine.phase === 'YELLOW') {
      // YELLOW expired → pick next lane
      let nextLane = null;
      let selectionReason = 'normal rotation, skipping empty lanes';
      
      // At phase boundaries, serve the longest-waiting occupied lane first.
      const overdue = LANES.filter(l => detections[l].vehicles > 0 && engine.laneIdleTimer[l] >= 30);
      overdue.sort((a, b) => engine.laneIdleTimer[b] - engine.laneIdleTimer[a]);
      if (overdue.length) {
        nextLane = overdue[0];
        selectionReason = `waiting-time priority: lane has waited ${engine.laneIdleTimer[nextLane]} seconds`;
        engine.laneIdleTimer[nextLane] = 0;
      }

      if (!nextLane) {
          nextLane = getNextLane(engine.activeLane);
          let attempts = 0;
          
          while (detections[nextLane].vehicles === 0 && attempts < 4) {
            nextLane = getNextLane(nextLane);
            attempts++;
          }

          if (attempts === 4) {
            recordDecision('DENSITY', 'No vehicles detected in any lane. All signals are RED; checking for arrivals.');
            engine.phase = 'ALL_RED';
            engine.timer = 2;
            return;
          }
      }

      engine.activeLane = nextLane;
      engine.phase = 'GREEN';
      const baseTime = getGreenDuration(nextLane);
      engine.timer = baseTime;
      recordDecision('DENSITY', `${laneName(nextLane)} receives ${baseTime} seconds of GREEN with ${detections[nextLane].vehicles} detected vehicles: ${selectionReason}${systemState.weather === 'Rain' ? '; rain allowance included within the 45-second allocation cap' : ''}.`);
    } else if (engine.phase === 'ALL_RED') {
      let foundLane = LANES.find(l => detections[l].vehicles > 0);
      if (foundLane) {
        engine.activeLane = foundLane;
        engine.phase = 'GREEN';
        const baseTime = getGreenDuration(foundLane);
        engine.timer = baseTime;
        recordDecision('DENSITY', `${laneName(foundLane)} has ${detections[foundLane].vehicles} detected vehicles. Leaving all-RED and assigning ${baseTime} seconds of GREEN.`);
      } else {
        engine.timer = 2;
      }
    }
  }

  // Save previous state for spike detection
  for (let l of LANES) {
    engine.prevVehicles[l] = detections[l].vehicles;
  }
}

function getGreenDuration(lane) {
  const count = Math.max(0, Number(detections[lane].vehicles) || 0);
  const weatherExtra = systemState.weather === 'Rain' ? 10 : 0;
  return Math.min(45, Math.max(10, 10 + Math.ceil(count) * 2 + weatherExtra));
}

function getNextLane(current) {
  let idx = LANES.indexOf(current);
  return LANES[(idx + 1) % LANES.length];
}

function updateExternalState() {
  const observed = LANES.filter(lane => detections[lane].ambulance);
  const priorityLane = engine.pendingAmbulanceLane || engine.ambulanceActiveLane;
  let stage = 'NORMAL';
  let message = systemState.mode === 'STATIC'
    ? 'Fixed-time control: each lane receives a 30-second slot. Automatic ambulance priority is available in AI mode.'
    : `${laneName(engine.activeLane)} is ${engine.phase.replace('_', ' ')}. GREEN allocation follows vehicle count (10-45s). Rotation skips empty lanes; longest-waiting overdue lanes receive priority.`;
  if (systemState.mode === 'AI' && engine.pendingAmbulanceLane) {
    stage = 'TRANSITION';
    message = `Ambulance confirmed in ${laneName(priorityLane)}. ${laneName(engine.activeLane)} is YELLOW (${engine.timer}s remaining), then RED. ${laneName(priorityLane)} will turn GREEN next; other lanes stay RED.`;
  } else if (systemState.mode === 'AI' && systemState.emergency) {
    stage = 'PRIORITY';
    message = `${laneName(priorityLane)} has GREEN ambulance priority. All other lanes are RED. GREEN is held without a countdown while ambulance detection is YES. When it changes to NO, a 3-second YELLOW transition leads back to normal scheduling.`;
  } else if (systemState.mode === 'AI' && observed.length) {
    stage = 'CONFIRMING';
    message = `Ambulance detected in ${observed.map(laneName).join(', ')}. Waiting for controller confirmation before changing priority.`;
  } else if (engine.phase === 'ALL_RED') {
    message = 'No vehicles detected. All signals are RED while the controller waits for traffic.';
  }
  systemState.control = { stage, message, activeLane: engine.activeLane, priorityLane, phase: engine.phase, remaining: engine.timer };

  for (let l of LANES) {
    // Vehicle count is always sent for all lanes (even paused/RED ones)
    systemState.lanes[l].vehicles = detections[l].vehicles;
    systemState.lanes[l].ambulance = detections[l].ambulance === true;
    
    // Bounding boxes: only for the ACTIVE lane (GREEN/YELLOW) in AI mode
    // Paused (RED) lanes show vehicle count but no overlay boxes
    const isActiveLane = (l === engine.activeLane) && (engine.phase === 'GREEN' || engine.phase === 'YELLOW');
    
    if (systemState.mode === 'AI' && isActiveLane) {
      systemState.lanes[l].boxes = detections[l].boxes || [];
      systemState.lanes[l].ambulanceBoxes = detections[l].ambulanceBoxes || [];
    } else {
      systemState.lanes[l].boxes = [];
      systemState.lanes[l].ambulanceBoxes = [];
    }

    if (engine.phase === 'ALL_RED') {
      systemState.lanes[l].signal = 'RED';
      systemState.lanes[l].time = 0;
      continue;
    }

    if (l === engine.activeLane) {
      systemState.lanes[l].signal = engine.phase;
      systemState.lanes[l].time = engine.timer;
    } else {
      systemState.lanes[l].signal = 'RED';
      systemState.lanes[l].time = 0;
    }
  }
}

// API Endpoints
app.get('/status', (req, res) => {
  res.json(systemState);
});

app.get('/reports/signal-decisions.csv', (req, res) => {
  if (reportError) return res.status(503).json({ error: 'Decision history could not be fully saved.' });

  try {
    const entries = fs.readFileSync(reportHistory, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const rows = [
      ['Timestamp (UTC)', 'Controller session (UTC)', 'Decision ID', 'Category', 'Mode', 'Weather',
        'Active lane', 'Phase', 'Seconds remaining', ...LANES.map(lane => `${laneName(lane)} vehicles`), 'Decision'],
      ...entries.map(entry => [
        new Date(entry.timestamp).toISOString(), entry.sessionStarted, entry.id, entry.category,
        entry.mode, entry.weather, entry.activeLane, entry.phase, entry.remainingSeconds,
        ...LANES.map(lane => entry.vehicles[lane]), entry.message,
      ]),
    ];
    const csv = rows.map(row => row.map(value => {
      const text = String(value ?? '');
      const safe = typeof value === 'string' && /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(text) ? "'" + text : text;
      return '"' + safe.replace(/"/g, '""') + '"';
    }).join(',')).join('\r\n');
    res.attachment('signal-decisions.csv').type('text/csv').send(csv + '\r\n');
  } catch (error) {
    console.error('Could not export signal decisions:', error.message);
    res.status(500).json({ error: 'Decision report unavailable.' });
  }
});

app.get('/reports/signal-decisions.pdf', (req, res) => {
  const pythonDir = path.resolve(__dirname, '../python');
  const venvPython = path.join(pythonDir, 'venv', ...(process.platform === 'win32'
    ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  const python = fs.existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'python' : 'python3');
  const csvUrl = `http://127.0.0.1:${server.address().port}/reports/signal-decisions.csv`;
  execFile(python, [path.join(pythonDir, 'signal_report.py'), csvUrl], {
    encoding: 'buffer', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  }, (error, pdf, stderr) => {
    if (error) {
      console.error('Could not generate decision PDF:', stderr.toString() || error.message);
      return res.status(500).json({ error: 'Decision PDF unavailable.' });
    }
    res.set('Cache-Control', 'no-store');
    res.attachment('signal-decision-analysis.pdf').type('application/pdf').send(pdf);
  });
});

app.post('/mode', (req, res) => {
  const { mode } = req.body;
  if (['AI', 'STATIC'].includes(mode)) {
    const { activeLane, phase } = engine;
    systemState.mode = mode;
    recordDecision('SYSTEM', `Control mode changed to ${mode}.`);

    systemState.emergency = false;
    engine.ambulanceActiveLane = null;
    engine.pendingAmbulanceLane = null;

    if (engine.phase === 'ALL_RED') {
      engine.phase = 'GREEN';
      engine.timer = 30;
      engine.activeLane = 'north';
    }

    if (engine.timer === null) engine.timer = 30;

    if (mode === 'STATIC' && engine.timer > 30) {
      engine.timer = 30;
    }

    recordSignalChange(activeLane, phase);
    res.json({ success: true, mode });
  } else {
    res.status(400).json({ error: 'Invalid mode' });
  }
});

// Endpoint for Python script to push detections (now with bbox data)
app.post('/detections', (req, res) => {
  const data = req.body;
  if (data) {
    if (data.timestamp) engine.lastPingTime = data.timestamp;
    
    for (let l of LANES) {
      if (data[l]) {
        detections[l].vehicles = data[l].vehicles !== undefined ? data[l].vehicles : detections[l].vehicles;
        detections[l].ambulance = data[l].ambulance !== undefined ? data[l].ambulance : detections[l].ambulance;
        detections[l].confidence = data[l].confidence !== undefined ? data[l].confidence : detections[l].confidence;
        // Accept bounding box arrays
        detections[l].boxes = Array.isArray(data[l].boxes) ? data[l].boxes : detections[l].boxes;
        detections[l].ambulanceBoxes = Array.isArray(data[l].ambulanceBoxes) ? data[l].ambulanceBoxes : detections[l].ambulanceBoxes;
      }
    }
    if (data.weather) detections.weather = data.weather;
  }
  res.json({ success: true });
});

const PORT = process.env.PORT || 5000;
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. TrafficSense Node may already be running.`);
    console.error(`Check http://localhost:${PORT}/status . Use the existing server or stop it before restarting.`);
  } else {
    console.error('Unable to start Node server:', error.message);
  }
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`Node Engine listening on port ${PORT}`);
});
