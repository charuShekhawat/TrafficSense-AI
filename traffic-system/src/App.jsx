import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const BACKEND_URL = 'http://localhost:5000';
const PYTHON_STREAM_URL = 'http://localhost:8000/stream';
const LANES = [
  { id: 'north', name: 'North Corridor', code: 'CAM-01', color: '#2dd4bf' },
  { id: 'east', name: 'East Corridor', code: 'CAM-02', color: '#10b981' },
  { id: 'south', name: 'South Corridor', code: 'CAM-03', color: '#059669' },
  { id: 'west', name: 'West Corridor', code: 'CAM-04', color: '#6ee7b7' },
];

const initialState = {
  mode: 'AI',
  emergency: false,
  events: [],
  control: null,
  north: { vehicles: 0, signal: 'RED', time: 0, ambulance: false },
  east: { vehicles: 0, signal: 'RED', time: 0, ambulance: false },
  south: { vehicles: 0, signal: 'RED', time: 0, ambulance: false },
  west: { vehicles: 0, signal: 'RED', time: 0, ambulance: false },
};

const signalTiming = lane => lane?.signal === 'GREEN' && lane?.time === null
  ? 'UNTIL AMBULANCE CLEARS'
  : lane?.time > 0 ? `${lane.time}s` : '';

const STATIC_SLOT = 30;
const MAX_ADAPTIVE_SLOT = 45;

function adaptiveSlotSeconds(vehicles, weather) {
  const count = Math.max(0, Number(vehicles) || 0);
  const rainAllowance = weather === 'Rain' ? 10 : 0;
  return count === 0 ? 0 : Math.min(MAX_ADAPTIVE_SLOT, 10 + Math.ceil(count) * 2 + rainAllowance);
}

function formatTimingDelta(saved) {

  if (saved > 0) return `+${saved}s saved`;
  if (saved < 0) return `${saved}s (${-saved}s extra)`;
  return '0s difference';
}

function TimingChart({ state }) {
  if (!state.control) return <p className="section-description">Waiting for controller data.</p>;

  const lanes = LANES.map(lane => ({
    ...lane,
    seconds: adaptiveSlotSeconds(state[lane.id].vehicles, state.weather),
  }));
  const adaptiveTotals = [0];
  lanes.forEach(({ seconds }) => adaptiveTotals.push(adaptiveTotals.at(-1) + seconds));
  const staticTotals = adaptiveTotals.map((_, index) => index * STATIC_SLOT);
  const scale = MAX_ADAPTIVE_SLOT * lanes.length;
  const x = index => 44 + index * 98;
  const y = seconds => 216 - seconds / scale * 184;

  return (
    <section className="timing-chart" aria-label="Green time comparison charts">
      <div className="timing-chart-heading">
        <h3>Cumulative green time</h3>
        <strong className="mono">{formatTimingDelta(staticTotals.at(-1) - adaptiveTotals.at(-1))}</strong>
      </div>
      <p className="section-description">Each point adds the next corridor in the order shown.</p>
      <figure className="timing-line-chart">
        <svg viewBox="0 0 480 250" role="img" aria-labelledby="timing-line-title timing-line-details">
          <title id="timing-line-title">Cumulative static and adaptive green time in seconds</title>
          <desc id="timing-line-details">
            {lanes.map(({ name }, index) =>
              `${name}: Static ${staticTotals[index + 1]} seconds, Adaptive ${adaptiveTotals[index + 1]} seconds.`,
            ).join(' ')}
          </desc>
          {[0, 30, 60, 90, 120, 150, 180].map(seconds => (
            <g key={seconds}>
              <line x1={x(0)} y1={y(seconds)} x2={x(4)} y2={y(seconds)} />
              <text x="36" y={y(seconds) + 4} textAnchor="end">{seconds}s</text>
            </g>
          ))}
          {['Start', ...lanes.map(({ name }) => name.split(' ')[0])].map((label, index) => (
            <g key={label}>
              <line x1={x(index)} y1={y(scale)} x2={x(index)} y2={y(0)} />
              <text x={x(index)} y="238" textAnchor="middle">{label}</text>
            </g>
          ))}
          {[['Static', staticTotals], ['Adaptive', adaptiveTotals]].map(([label, totals]) => (
            <g key={label} className={`timing-series timing-series-${label.toLowerCase()}`}>
              <polyline points={totals.map((seconds, index) => `${x(index)},${y(seconds)}`).join(' ')} />
              {totals.map((seconds, index) => (
                <circle key={index} cx={x(index)} cy={y(seconds)} r={label === 'Static' ? 6 : 3.5}>
                  <title>{label} · {index ? lanes[index - 1].name : 'Start'} · {seconds}s</title>
                </circle>
              ))}
            </g>
          ))}
        </svg>
        <figcaption>
          <span className="timing-legend-static">Static · {staticTotals.at(-1)}s</span>
          <span className="timing-legend-adaptive">Adaptive · {adaptiveTotals.at(-1)}s</span>
        </figcaption>
      </figure>
      <h3>Green time by corridor</h3>
      <div className="timing-chart-grid">
        {lanes.map(({ id, name, seconds }) => (
          <div className="timing-chart-lane" key={id}>
            <div className="timing-chart-heading">
              <h4>{name}</h4>
              <strong className="mono">{formatTimingDelta(STATIC_SLOT - seconds)}</strong>
            </div>
            {[['Static', STATIC_SLOT], ['Adaptive', seconds]].map(([label, duration]) => (
              <div className="timing-chart-row" key={label}>
                <span>{label}</span>
                <div className="timing-chart-track" aria-hidden="true">
                  <div className={label === 'Static' ? 'timing-bar-static' : 'timing-bar-adaptive'}
                    style={{ width: `${duration / MAX_ADAPTIVE_SLOT * 100}%` }} />
                </div>
                <span className="mono">{duration}s</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function VideoUpload({ lane }) {
  const [busy, setBusy] = useState(false);
  const [filename, setFilename] = useState(`${lane}.mp4`);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    fetch('http://localhost:8000/sources').then((r) => r.json()).then((data) => {
      if (active && data[lane]) setFilename(data[lane].filename);
    }).catch(() => {});
    return () => { active = false; };
  }, [lane]);
  const upload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 500 * 1024 * 1024) {
      setError('Choose a video smaller than 500 MB.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`http://localhost:8000/videos/${lane}?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Upload failed');
      setFilename(result.filename);
    } catch (err) {
      setError(err.message || 'Unable to upload video');
    } finally {
      setBusy(false);
    }
  };
  return <div className="upload-row"><label className="button upload-button">{busy?'Uploading...':`Upload ${titleCase(lane)} Video`}<input type="file" accept=".mp4,.avi,.mov,.mkv,.webm,.m4v" disabled={busy} onChange={upload} aria-label={`Upload ${lane} video`}/></label><span className="filename" title={filename}>{filename}</span>{error&&<span className="error" role="alert">{error}</span>}</div>;
}

const PAGES = [
  {id:'overview', title:'Overview', description:'A live view of your intersection.'},
  {id:'cameras', title:'Live Cameras', description:'Four directions. One connected intersection.'},
  {id:'decisions', title:'Signal Decisions', description:'Understand every priority and signal change.'},
  {id:'comparison', title:'Static vs Dynamic', description:'Fixed timing and live controller behavior.'},
  {id:'settings', title:'Settings & Demo', description:'Display preferences and presentation controls.'},
];
const titleCase = text => text.charAt(0).toUpperCase() + text.slice(1);
const pageFromHash = () => PAGES.some(p=>p.id===location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
function Signal({lane}) { return <span className={`signal signal-${(lane?.signal || 'RED').toLowerCase()}`}><i />{lane?.signal || 'RED'}</span>; }
function Camera({id, name, code, lane, boxes}) {
  const [failed,setFailed]=useState(false);
  return <article className={`card camera ${lane.ambulance ? 'camera-emergency' : ''}`}>
    <div className="camera-heading"><div><span className="eyebrow">{code}</span><h3>{name}</h3></div><Signal lane={lane}/></div>
    <div className="camera-picture"><img src={`${PYTHON_STREAM_URL}/${id}?boxes=${boxes}`} alt={`${name} live video`} onLoad={()=>setFailed(false)} onError={()=>setFailed(true)}/><span className="live-stamp">{failed?'FEED UNAVAILABLE':'LIVE FEED'}</span></div>
    <div className="camera-metrics"><div><span>Vehicles</span><strong>{lane.vehicles}</strong></div><div><span>Ambulance detected</span><strong className={lane.ambulance?'text-danger':'text-muted'}>{lane.ambulance?'YES':'NO'}</strong></div><div><span>Signal timing</span><strong className="timing">{signalTiming(lane)||'Waiting'}</strong></div></div>
    <VideoUpload lane={id}/>
  </article>;
}
function DecisionReportButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function downloadReport() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${BACKEND_URL}/reports/signal-decisions.pdf`);
      if (!response.ok) throw new Error('Could not download the decision report.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'signal-decision-analysis.pdf';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError('Could not download the decision report. Check the controller connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="button" disabled={busy} onClick={downloadReport}>
        {busy ? 'Preparing report…' : 'Download Analysis Report (PDF)'}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function DecisionView({state}) {
  return <div className="page-stack"><section className="card"><div className="section-heading"><div><span className="eyebrow">CONTROLLER STATUS</span><h2>Live Signal Decisions</h2></div><DecisionReportButton/><span className={`pill ${state.emergency?'pill-danger':''}`}>{state.control?.stage||'CONNECTING'}</span></div><p className="decision-message" role="status">{state.control?.message||'Waiting for controller decisions...'}</p><div className="lane-grid">{LANES.map(({id,name})=><article className={`lane-tile ${state.control?.priorityLane===id?'priority-tile':''}`} key={id}><span className="eyebrow">{name}</span><Signal lane={state[id]}/><span>{signalTiming(state[id])||'Waiting'}</span><small>{state[id].vehicles} vehicles{state.control?.priorityLane===id?' / AMBULANCE PRIORITY':''}</small></article>)}</div></section><div className="event-grid">{['AMBULANCE','DENSITY','SYSTEM'].map(category=><section className="card" key={category}><span className="eyebrow">DECISION LOG</span><h2>{category==='AMBULANCE'?'Ambulance Priority':category==='DENSITY'?'Density & Scheduling':'System Updates'}</h2>{(state.events||[]).filter(e=>e.category===category).slice(0,8).map(e=><div className="event" key={e.id}><time>{new Date(e.timestamp).toLocaleTimeString()}</time><p>{e.message}</p></div>)}{!(state.events||[]).some(e=>e.category===category)&&<p className="empty-state">No decisions recorded yet.</p>}</section>)}</div></div>;
}
export default function App() {
  const [state,setState]=useState(initialState);
  const [connected,setConnected]=useState(false);
  const [page,setPage]=useState(pageFromHash);
  const [sidebarOpen,setSidebarOpen]=useState(false);
  const [theme,setTheme]=useState(()=>{try{return localStorage.getItem('trafficsense-theme')==='light'?'light':'dark';}catch{return 'dark';}});
  const [boxes,setBoxes]=useState(false);
  const [demoLane,setDemoLane]=useState(null);
  const [error,setError]=useState('');
  const [modeBusy,setModeBusy]=useState(false);
  const [fullscreen,setFullscreen]=useState(false);
  useEffect(()=>{document.documentElement.dataset.theme=theme;try{localStorage.setItem('trafficsense-theme',theme);}catch{/* Storage may be disabled. */}},[theme]);
  useEffect(()=>{
    const onHash=()=>{setPage(pageFromHash());setSidebarOpen(false);document.querySelector('main')?.scrollTo(0,0);};
    const onFull=()=>setFullscreen(Boolean(document.fullscreenElement));
    const onKey=e=>{if(e.key==='Escape')setSidebarOpen(false);};
    addEventListener('hashchange',onHash);document.addEventListener('fullscreenchange',onFull);addEventListener('keydown',onKey);
    return()=>{removeEventListener('hashchange',onHash);document.removeEventListener('fullscreenchange',onFull);removeEventListener('keydown',onKey);};
  },[]);
  useEffect(()=>{
    const controller=new AbortController();const socket=io(BACKEND_URL);let received=false;
    fetch(`${BACKEND_URL}/status`,{signal:controller.signal}).then(r=>r.json()).then(data=>{if(data.lanes&&!received)setState({...initialState,...data,...data.lanes});}).catch(()=>{});
    socket.on('connect',()=>setConnected(true));socket.on('disconnect',()=>setConnected(false));socket.on('state_update',data=>{received=true;setState(data);});
    return()=>{controller.abort();socket.disconnect();};
  },[]);
  async function changeMode(mode){setError('');setModeBusy(true);try{const r=await fetch(`${BACKEND_URL}/mode`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode})});if(!r.ok)throw Error('Unable to change controller mode.');}catch(e){setError(e.message);}finally{setModeBusy(false);}}
  async function toggleFullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else setError('Fullscreen is unavailable. The layout already fits your screen.');}catch{setError('Unable to enter fullscreen. Try the browser fullscreen control.');}}
  const selected=PAGES.find(p=>p.id===page);
  const total=LANES.reduce((n,{id})=>n+state[id].vehicles,0);
  const ambulanceLanes=LANES.filter(({id})=>state[id].ambulance);
  const go=id=>{location.hash=id;setSidebarOpen(false);};
  const displayLane=id=>demoLane?{...state[id],signal:demoLane===id?'GREEN':'RED',time:demoLane===id?null:0}:state[id];
  return <div className="app-shell">
    {sidebarOpen&&<button className="sidebar-scrim" aria-label="Close navigation" onClick={()=>setSidebarOpen(false)}/>}
    <aside className={`sidebar ${sidebarOpen?'sidebar-open':''}`} aria-label="Main navigation">
      <a href="#overview" className="brand" onClick={()=>setSidebarOpen(false)}><span className="brand-icon">TS</span><span>TrafficSense <b>AI</b><small>INTERSECTION CONTROL</small></span></a>
      <button className="button sidebar-close" onClick={()=>setSidebarOpen(false)}>Close menu</button>
      <span className="nav-label">WORKSPACE</span><nav>{PAGES.map((p,i)=><a href={`#${p.id}`} className={`nav-link ${page===p.id?'nav-active':''}`} aria-current={page===p.id?'page':undefined} key={p.id} onClick={()=>setSidebarOpen(false)}><span>0{i+1}</span>{p.title}<span className="nav-arrow">/</span></a>)}</nav>
      <div className="sidebar-note"><span className="eyebrow">FOUR-WAY INTERSECTION</span><div className="mini-cross"><span>N</span><span>W</span><b>+</b><span>E</span><span>S</span></div><p>Monitor traffic. Understand decisions. Prioritize emergencies.</p></div>
      <div className="sidebar-footer"><span className={`connection ${connected?'online':''}`}><i/>{connected?'Controller connected':'Controller offline'}</span><span>TrafficSense AI / Command Center</span></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="topbar-left"><button className="button menu-button" onClick={()=>setSidebarOpen(true)} aria-expanded={sidebarOpen}>Menu</button><span className="breadcrumb">Workspace <span>/</span> <b>{selected.title}</b></span></div><div className="topbar-actions"><span className={`connection top-connection ${connected?'online':''}`}><i/>{connected?'Live system':'Offline'}</span><button className="button" onClick={()=>setTheme(theme==='dark'?'light':'dark')} aria-label={`Switch to ${theme==='dark'?'light':'dark'} mode`}>{theme==='dark'?'Light mode':'Dark mode'}</button><button className="button fullscreen-button" onClick={toggleFullscreen}>{fullscreen?'Exit fullscreen':'Fullscreen'}</button></div></header>
    <main className="main-content"><div className="page-heading"><div><span className="eyebrow">TRAFFICSENSE AI / COMMAND CENTER</span><h1>{selected.title}</h1><p>{selected.description}</p></div><div className="mode-switch" aria-label="Controller mode"><button disabled={modeBusy} aria-pressed={state.mode==='AI'} className={state.mode==='AI'?'selected':''} onClick={()=>changeMode('AI')}>AI Adaptive</button><button disabled={modeBusy} aria-pressed={state.mode==='STATIC'} className={state.mode==='STATIC'?'selected':''} onClick={()=>changeMode('STATIC')}>Static 30s</button></div></div>
    {error&&<div className="notice notice-error" role="alert">{error}<button className="button" onClick={()=>setError('')}>Dismiss</button></div>}
    {!connected&&<div className="notice notice-error" role="status">Controller disconnected. Displayed counts and signals may be outdated.</div>}
    {demoLane&&<div className="notice">Visual demo: {titleCase(demoLane)} is highlighted in camera cards only. Live controller decisions are unchanged.<button className="button" onClick={()=>setDemoLane(null)}>End demo</button></div>}
    {page!=='decisions'&&(state.emergency||state.control?.stage==='TRANSITION')&&<div className="notice notice-priority" role="status"><div><strong>AMBULANCE PRIORITY</strong><p>{state.control?.message}</p></div><button className="button" onClick={()=>go('decisions')}>View decisions</button></div>}
    {page==='overview'&&<div className="page-stack"><div className="stat-grid"><article className="card stat"><span className="eyebrow">INTERSECTION LOAD</span><strong>{total}<small>vehicles</small></strong><p>Latest detections across four corridors</p></article><article className="card stat"><span className="eyebrow">ACTIVE CORRIDOR</span><strong>{state.control?.activeLane?titleCase(state.control.activeLane):'--'}</strong><p>{state.control?.phase?.replace('_',' ')||'Waiting for controller'}</p></article><article className="card stat"><span className="eyebrow">AMBULANCE DETECTION</span><strong className={ambulanceLanes.length?'text-danger':''}>{ambulanceLanes.length}<small>lanes</small></strong><p>{ambulanceLanes.length?ambulanceLanes.map(l=>titleCase(l.id)).join(', '):'No ambulance currently detected'}</p></article><article className="card stat"><span className="eyebrow">CONTROL MODE</span><strong>{state.mode==='AI'?'Adaptive':'Static'}</strong><p>{state.mode==='AI'?'Live traffic and ambulance priority':'Fixed 30-second signal slots'}</p></article></div>
    <section className="card"><div className="section-heading"><div><span className="eyebrow">LIVE CORRIDORS</span><h2>Intersection Overview</h2></div><button className="button" onClick={()=>go('cameras')}>Open cameras</button></div><div className="lane-grid">{LANES.map(({id,name})=><article className="lane-tile" key={id}><span className="eyebrow">{name}</span><Signal lane={state[id]}/><strong className="lane-count">{state[id].vehicles}<small>vehicles</small></strong><span>{signalTiming(state[id])||'Waiting'}</span><span className={state[id].ambulance?'text-danger':'text-muted'}>Ambulance: {state[id].ambulance?'YES':'NO'}</span></article>)}</div></section>
    <section className="card"><div className="section-heading"><h2>Current Controller Decision</h2><button className="button" onClick={()=>go('decisions')}>View decision log</button></div><p className="decision-message">{state.control?.message||'Waiting for detections...'}</p></section>
    <section className="card"><div className="section-heading"><h2>Recent Activity</h2><span className="eyebrow">SERVER EVENTS</span></div>{(state.events||[]).slice(0,5).map(e=><div className="activity-row" key={e.id}><time>{new Date(e.timestamp).toLocaleTimeString()}</time><span className={`pill ${e.category==='AMBULANCE'?'pill-danger':''}`}>{e.category}</span><p>{e.message}</p></div>)}{!state.events?.length&&<p className="empty-state">Waiting for controller events.</p>}</section></div>}
    {page==='cameras'&&<div className="page-stack"><div className="view-toolbar"><p>Independent video sources / Detection target: every 2 seconds</p><button className="button" aria-pressed={boxes} onClick={()=>setBoxes(!boxes)}>Detection boxes: {boxes?'ON':'OFF'}</button></div><div className="camera-grid">{LANES.map(lane=><Camera key={lane.id} {...lane} lane={displayLane(lane.id)} boxes={boxes}/>)}</div></div>}
    {page==='decisions'&&<DecisionView state={state}/>}
    {page==='comparison'&&<section className="card"><div className="section-heading"><h2>Signal Timing Comparison</h2><span className="pill">{state.mode} MODE</span></div><p className="section-description">Static mode uses fixed 30-second slots. AI allocates GREEN using 10 + 2 seconds per detected vehicle (10-45s), skips empty lanes, and prioritizes the longest-waiting lane after 30s at phase selection. Traffic-spike extensions and ambulance priority override normal timing. Delta estimates time saved against the fixed slot using current detections and weather. Live timing shows the controller countdown.</p><TimingChart state={state}/><div className="table-scroll"><table><thead><tr><th>Corridor</th><th>Live vehicles</th><th>Static slot</th><th>Current signal</th><th>Live timing</th><th>Delta</th><th>Ambulance</th></tr></thead><tbody>{LANES.map(({id,name})=><tr key={id}><td>{name}</td><td className="mono">{state[id].vehicles}</td><td>30s fixed</td><td><Signal lane={state[id]}/></td><td>{signalTiming(state[id])||'Waiting'}</td><td className="mono">{state.control ? formatTimingDelta(STATIC_SLOT - adaptiveSlotSeconds(state[id].vehicles, state.weather)) : 'Waiting'}</td><td className={state[id].ambulance?'text-danger':''}>{state[id].ambulance?'YES':'NO'}</td></tr>)}</tbody></table></div></section>}
    {page==='settings'&&<div className="settings-grid"><section className="card"><span className="eyebrow">PERSONALIZE</span><h2>Display Preferences</h2><div className="setting-row"><div><h3>Appearance</h3><p>Switch between dark and bright themes.</p></div><button className="button" onClick={()=>setTheme(theme==='dark'?'light':'dark')}>{theme==='dark'?'Use light mode':'Use dark mode'}</button></div><div className="setting-row"><div><h3>Detection boxes</h3><p>Optional boxes in camera feeds.</p></div><button className="button" aria-pressed={boxes} onClick={()=>setBoxes(!boxes)}>{boxes?'ON':'OFF'}</button></div><div className="setting-row"><div><h3>Presentation fullscreen</h3><p>Use the entire display.</p></div><button className="button" onClick={toggleFullscreen}>{fullscreen?'Exit':'Enter fullscreen'}</button></div></section><section className="card"><span className="eyebrow">PRESENTATION</span><h2>Visual Emergency Demo</h2><p className="section-description">Preview a GREEN lane in camera cards. This visual simulation does not change server detections or signals.</p><div className="demo-grid">{LANES.map(({id})=><button className={`button ${demoLane===id?'demo-selected':''}`} key={id} onClick={()=>setDemoLane(demoLane===id?null:id)}>{demoLane===id?'Stop ':''}{titleCase(id)}</button>)}</div><button className="button" onClick={()=>go('cameras')}>View camera cards</button></section></div>}
    <footer className="page-footer"><span>TrafficSense AI</span><span>Autonomous Smart Traffic Management System</span></footer></main></div></div>;
}
