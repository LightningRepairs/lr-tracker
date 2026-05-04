import React, { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { getSettings, getDefaults } from '../lib/settings';

const BLUE='#1B9BD4',NAVY='#1a2a3a',YELLOW='#F5C518',BLUE_LIGHT='#e8f6fc',BORDER='#b8dff0';
const GREEN='#2d8a4e',GREEN_BG='#e6f5ec',AMBER='#9a6000',AMBER_BG='#fff3d0',RED='#b52020',RED_BG='#fce8e8';

function pad(n){return String(n).padStart(2,'0');}
function fmtTimer(ms){const t=Math.floor(ms/1000),m=Math.floor(t/60),s=t%60,cs=Math.floor((ms%1000)/10);return`${pad(m)}:${pad(s)}:${pad(cs)}`;}
function effColor(pct,g=90,y=79){if(pct===null)return'#aac8d8';return pct>=g?GREEN:pct>=y?AMBER:RED;}
function rowBg(pct,g=90,y=79){if(pct===null)return'transparent';return pct>=g?GREEN_BG:pct>=y?AMBER_BG:RED_BG;}
const EMPTY_ROW=()=>({_id:Math.random().toString(36).slice(2),dbId:null,ticketNumber:'',deviceTypeId:'',deviceModelId:'',repairTypeId:'',actualMinutes:'',laborCost:'',isFullSet:false,notes:'',addOns:[],timerMs:0,timerState:'idle'});

export default function AdminSheetView({tech, onBack, viewDate, currentUser}){
  const [rows,setRows]=useState([]);
  const [deviceTypes,setDeviceTypes]=useState([]);
  const [deviceModels,setDeviceModels]=useState([]);
  const [repairTypes,setRepairTypes]=useState([]);
  const [bookTimes,setBookTimes]=useState([]);
  const [addOnOptions,setAddOnOptions]=useState([]);
  const [settings,setSettings]=useState(getDefaults());
  const [loading,setLoading]=useState(true);
  const [editMode,setEditMode]=useState(false);
  const [openPopup,setOpenPopup]=useState(null);
  const timerRefs=useRef({});
  const liveTimerRefs=useRef({});
  const today=new Date().toISOString().slice(0,10);
  const targetDate=viewDate||today;
  const isToday=targetDate===today;

  useEffect(()=>{
    const load=async()=>{
      const s=await getSettings();setSettings(s);
      const[dt,dm,rt,bt,ao]=await Promise.all([
        supabase.from('device_types').select('*').eq('active',true).order('sort_order'),
        supabase.from('device_models').select('*').eq('active',true).order('sort_order'),
        supabase.from('repair_types').select('*').eq('active',true).order('sort_order'),
        supabase.from('book_times').select('*'),
        supabase.from('add_ons').select('*').eq('active',true).order('sort_order'),
      ]);
      setDeviceTypes(dt.data||[]);setDeviceModels(dm.data||[]);setRepairTypes(rt.data||[]);
      setBookTimes(bt.data||[]);setAddOnOptions(ao.data||[]);
    };
    load();
  },[]);

  const loadRows=useCallback(async()=>{
    const{data}=await supabase.from('tickets').select('*,ticket_add_ons(*)').eq('technician_id',tech.id).eq('work_date',targetDate).order('created_at');
    if(data&&data.length>0){
      const loaded=data.map(t=>({
        _id:t.id,dbId:t.id,ticketNumber:t.ticket_number||'',deviceTypeId:t.device_type_id||'',
        deviceModelId:t.device_model_id||'',repairTypeId:t.repair_type_id||'',
        actualMinutes:t.actual_minutes!=null?String(t.actual_minutes):'',
        laborCost:t.labor_cost!=null?String(t.labor_cost):'',isFullSet:t.is_full_set||false,
        notes:t.notes||'',
        addOns:(t.ticket_add_ons||[]).map(ta=>({id:ta.add_on_id,mins:ta.book_minutes})),
        timerMs:0,timerState:'idle',
      }));
      const blanks=isToday?Math.max(0,parseInt(settings.default_rows||10)-loaded.length):0;
      setRows([...loaded,...Array.from({length:blanks},EMPTY_ROW)]);
    } else {
      setRows(isToday?Array.from({length:parseInt(settings.default_rows||10)},EMPTY_ROW):[]);
    }
    setLoading(false);
  },[tech.id,targetDate,isToday,settings.default_rows]);

  useEffect(()=>{
    if(!loading||Object.keys(settings).length>1){loadRows();}
  },[loadRows]);

  // Live reload subscription (today only)
  useEffect(()=>{
    if(!isToday)return;
    const sub=supabase.channel(`admin-sheet-${tech.id}`)
      .on('postgres_changes',{event:'*',schema:'public',table:'tickets',filter:`technician_id=eq.${tech.id}`},()=>loadRows())
      .subscribe();
    return()=>supabase.removeChannel(sub);
  },[tech.id,isToday,loadRows]);

  // Live timers for read-only mode (just display, don't interact)
  useEffect(()=>{
    if(editMode)return;
    const interval=setInterval(()=>{
      setRows(prev=>prev.map(r=>r.timerState==='running'?{...r,timerMs:Date.now()-(r.timerStart||Date.now())}:r));
    },100);
    return()=>clearInterval(interval);
  },[editMode]);

  const getBookMinutes=useCallback((repairTypeId,deviceModelId)=>{
    const rt=repairTypes.find(r=>r.id===repairTypeId);
    if(!rt||rt.is_labor)return null;
    const bt=bookTimes.find(b=>b.repair_type_id===repairTypeId&&b.device_model_id===deviceModelId);
    if(!bt||bt.is_na)return null;
    return bt.minutes;
  },[repairTypes,bookTimes]);

  const getLaborBook=useCallback((repairTypeId,laborCost)=>{
    const rt=repairTypes.find(r=>r.id===repairTypeId);
    if(!rt?.is_labor)return null;
    const cost=parseFloat(laborCost)||0;
    const mult=parseFloat(rt.labor_multiplier)||0.3;
    return cost>0?Math.round(cost*mult):null;
  },[repairTypes]);

  const calcBook=useCallback((row)=>{
    const rt=repairTypes.find(r=>r.id===row.repairTypeId);
    const base=rt?.is_labor?getLaborBook(row.repairTypeId,row.laborCost):getBookMinutes(row.repairTypeId,row.deviceModelId);
    if(base===null)return null;
    return base+(row.addOns||[]).reduce((s,a)=>s+a.mins,0);
  },[repairTypes,getBookMinutes,getLaborBook]);

  const saveRow=useCallback(async(row)=>{
    if(!row.ticketNumber&&!row.repairTypeId)return;
    const book=calcBook(row);
    const actual=parseFloat(row.actualMinutes)||null;
    const pct=actual&&book?Math.round((book/actual)*100):null;
    const effPct=actual&&book&&actual>0?Math.round((book/actual)*100):null;
    const payload={technician_id:tech.id,ticket_number:row.ticketNumber||null,device_type_id:row.deviceTypeId||null,device_model_id:row.deviceModelId||null,repair_type_id:row.repairTypeId||null,book_minutes:book,actual_minutes:actual,labor_cost:parseFloat(row.laborCost)||null,is_full_set:row.isFullSet,notes:row.notes||null,efficiency_pct:effPct,work_date:targetDate};
    let ticketId=row.dbId;
    if(row.dbId){
      await supabase.from('tickets').update(payload).eq('id',row.dbId);
    } else {
      const{data}=await supabase.from('tickets').insert(payload).select().single();
      if(data){ticketId=data.id;setRows(prev=>prev.map(r=>r._id===row._id?{...r,dbId:data.id}:r));}
    }
    if(ticketId){
      await supabase.from('ticket_add_ons').delete().eq('ticket_id',ticketId);
      if((row.addOns||[]).length>0){
        await supabase.from('ticket_add_ons').insert(row.addOns.map(a=>({ticket_id:ticketId,add_on_id:a.id,book_minutes:a.mins})));
      }
    }
  },[tech.id,targetDate,calcBook]);

  const updateRow=useCallback((id,updates)=>{
    setRows(prev=>prev.map(r=>{
      if(r._id!==id)return r;
      const updated={...r,...updates};
      clearTimeout(timerRefs.current['save_'+id]);
      timerRefs.current['save_'+id]=setTimeout(()=>saveRow(updated),800);
      return updated;
    }));
  },[saveRow]);

  const toggleAddOn=(rowId,ao)=>{
    setRows(prev=>prev.map(r=>{
      if(r._id!==rowId)return r;
      const exists=(r.addOns||[]).find(a=>a.id===ao.id);
      const newAO=exists?(r.addOns||[]).filter(a=>a.id!==ao.id):[...(r.addOns||[]),{id:ao.id,mins:ao.book_minutes,name:ao.name}];
      const updated={...r,addOns:newAO};
      clearTimeout(timerRefs.current['save_'+rowId]);
      timerRefs.current['save_'+rowId]=setTimeout(()=>saveRow(updated),800);
      return updated;
    }));
  };

  const addRow=()=>setRows(prev=>[...prev,EMPTY_ROW()]);

  const clearRow=async(row)=>{
    if(!window.confirm('Remove this row? This cannot be undone.'))return;
    if(row.dbId){
      await supabase.from('ticket_add_ons').delete().eq('ticket_id',row.dbId);
      await supabase.from('tickets').delete().eq('id',row.dbId);
    }
    setRows(prev=>prev.filter(r=>r._id!==row._id));
  };

  const effG=parseInt(settings.efficiency_green||90);
  const effY=parseInt(settings.efficiency_yellow||79);
  const filledRows=rows.filter(r=>r.ticketNumber);
  const repaired=filledRows.filter(r=>{const rt=repairTypes.find(x=>x.id===r.repairTypeId);return rt&&!rt.is_diagnosis;});
  const diagnosed=filledRows.filter(r=>{const rt=repairTypes.find(x=>x.id===r.repairTypeId);return rt?.is_diagnosis;});
  const timed=rows.filter(r=>{const a=parseFloat(r.actualMinutes)||0;return a>0&&calcBook(r)!==null;});
  const totA=timed.reduce((s,r)=>s+(parseFloat(r.actualMinutes)||0),0);
  const totB=timed.reduce((s,r)=>s+(calcBook(r)||0),0);
  const avgEff=timed.length>0?Math.round((totB/totA)*100):null;
  const dateStr=new Date(targetDate+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});

  if(loading)return<div style={{color:'#fff',textAlign:'center',padding:'3rem'}}>Loading...</div>;

  return(
    <div style={{maxWidth:'1400px',margin:'0 auto'}}>
      {/* Top bar */}
      <div style={{display:'flex',alignItems:'center',gap:'12px',marginBottom:'1rem',flexWrap:'wrap'}}>
        <button onClick={onBack} style={{background:'#fff',border:`1px solid ${BORDER}`,borderRadius:'8px',padding:'6px 14px',fontSize:'13px',cursor:'pointer',fontFamily:'inherit',color:NAVY}}>← Back to Team Overview</button>
        {editMode?(
          <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
            <div style={{background:'#fce8e8',border:'1px solid #f0aaaa',borderRadius:'8px',padding:'5px 14px',fontSize:'12px',fontWeight:700,color:RED}}>⚠️ Edit Mode Active</div>
            <button onClick={()=>setEditMode(false)} style={{background:'transparent',border:'1px solid #d0cdc5',borderRadius:'8px',padding:'5px 12px',fontSize:'12px',cursor:'pointer',color:'#666'}}>Exit Edit Mode</button>
          </div>
        ):currentUser?.role==='admin'?(
          <button onClick={()=>{if(window.confirm(`Enter edit mode for ${tech.name}'s sheet? Their timers will not be affected.`))setEditMode(true);}}
            style={{background:YELLOW,color:NAVY,border:'none',borderRadius:'8px',padding:'6px 16px',fontSize:'13px',fontWeight:700,cursor:'pointer'}}>
            ✏️ Enter Edit Mode
          </button>
        ):null}
        <div style={{display:'flex',alignItems:'center',gap:'6px',marginLeft:'auto'}}>
          <div style={{width:8,height:8,borderRadius:'50%',background:isToday?GREEN:'#aaa'}}/>
          <span style={{fontSize:'12px',color:'rgba(255,255,255,0.7)'}}>{isToday?'Live':'Historical view'}</span>
        </div>
      </div>

      {/* Header */}
      <div style={{background:BLUE,borderRadius:'12px 12px 0 0',padding:'0.85rem 1.5rem',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:'12px'}}>
          <div style={{background:NAVY,borderRadius:'10px',padding:'8px 18px',border:'2px solid rgba(255,255,255,0.2)'}}>
            <div style={{fontSize:'10px',fontWeight:700,color:'rgba(255,255,255,0.5)',textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'2px'}}>Technician</div>
            <div style={{fontSize:'20px',fontWeight:800,color:YELLOW}}>{tech.name}</div>
          </div>
          {editMode&&<div style={{background:'rgba(245,197,24,0.2)',borderRadius:'6px',padding:'4px 10px',fontSize:'11px',color:YELLOW,fontWeight:700,border:'1px solid rgba(245,197,24,0.4)'}}>Admin editing</div>}
          {!editMode&&<div style={{background:'rgba(255,255,255,0.15)',borderRadius:'6px',padding:'4px 10px',fontSize:'11px',color:'#fff',fontWeight:600}}>👁 Read-only</div>}
        </div>
        <div style={{textAlign:'center'}}>
          <div style={{color:'#fff',fontWeight:700,fontSize:'14px',textTransform:'uppercase',letterSpacing:'0.08em'}}>Daily Ticket Tracker</div>
          <div style={{color:'rgba(255,255,255,0.75)',fontSize:'11px',marginTop:'2px'}}>{dateStr}</div>
        </div>
        <div style={{fontSize:'11px',color:'rgba(255,255,255,0.6)'}}>{editMode?'Auto-saves':'View only'}</div>
      </div>

      {/* Stats */}
      <div style={{background:BLUE,padding:'0 1.5rem 0.85rem'}}>
        <div style={{textAlign:'center',marginBottom:'8px'}}>
          <div style={{display:'inline-flex',alignItems:'center',gap:'10px',background:NAVY,border:'1px solid rgba(255,255,255,0.15)',borderRadius:'10px',padding:'6px 20px'}}>
            <span style={{fontSize:'11px',fontWeight:700,color:'rgba(255,255,255,0.6)',textTransform:'uppercase',letterSpacing:'0.1em'}}>Avg Efficiency</span>
            <span style={{fontSize:'20px',fontWeight:800,color:avgEff===null?YELLOW:effColor(avgEff,effG,effY)}}>{avgEff===null?'—':`${avgEff}%`}</span>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:'10px'}}>
          {[['Total Repaired',repaired.length],['Total Diagnosed',diagnosed.length],['Total Tickets',filledRows.length],['Book Time',totB>0?`${totB}m`:'—'],['Actual Time',totA>0?`${totA}m`:'—']].map(([label,val])=>(
            <div key={label} style={{background:NAVY,borderRadius:'8px',padding:'0.65rem 0.85rem',border:'1px solid rgba(255,255,255,0.1)'}}>
              <div style={{fontSize:'10px',color:'rgba(255,255,255,0.85)',textTransform:'uppercase',letterSpacing:'0.05em',fontWeight:700,marginBottom:'3px'}}>{label}</div>
              <div style={{fontSize:'19px',fontWeight:700,color:'#fff'}}>{val}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={{background:'#fff',borderRadius:'0 0 12px 12px',border:`1.5px solid ${BORDER}`,borderTop:'none',overflow:'hidden'}}>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:'12px',minWidth:'1200px'}}>
            <thead>
              <tr style={{background:NAVY}}>
                {['Ticket #','Device Type','Model','Repair Type','Book','Actual (min)','+/− min','Efficiency','Timer','Add-ons','Notes',''].map(h=>(
                  <th key={h} style={{padding:'8px 6px',textAlign:'left',fontWeight:700,fontSize:'10px',color:'#7aafc8',textTransform:'uppercase',letterSpacing:'0.05em',borderBottom:`2px solid ${BLUE}`,whiteSpace:'nowrap'}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row,idx)=>{
                const modelsForType=deviceModels.filter(m=>m.device_type_id===row.deviceTypeId);
                const repairsForType=repairTypes.filter(r=>r.device_type_id===row.deviceTypeId);
                const addOnsForType=addOnOptions.filter(a=>a.device_type_id===row.deviceTypeId);
                const rt=repairTypes.find(r=>r.id===row.repairTypeId);
                const isLabor=rt?.is_labor||false;
                const bookRaw=calcBook(row);
                const book=row._bookOverride!=null?row._bookOverride:bookRaw;
                const actual=parseFloat(row.actualMinutes)||0;
                const pct=(actual>0&&book!==null)?Math.round((book/actual)*100):null;
                const diff=(actual>0&&book!==null)?Math.round(actual-book):null;
                const bg=rowBg(pct,effG,effY);
                const diffColor=diff===null?'#aac8d8':diff<=0?GREEN:RED;
                const baseBook=isLabor?getLaborBook(row.repairTypeId,row.laborCost):getBookMinutes(row.repairTypeId,row.deviceModelId);

                // Selects and inputs - editable in edit mode, read-only otherwise
                const readOnly=!editMode;

                return(
                  <React.Fragment key={row._id}>
                    <tr style={{background:bg,borderBottom:`1px solid #cceaf7`}}>
                      <td style={{padding:'4px'}}>
                        {readOnly
                          ?<span style={{padding:'4px 6px',display:'block',fontSize:'12px'}}>{row.ticketNumber||String(idx+1)}</span>
                          :<input value={row.ticketNumber} onChange={e=>updateRow(row._id,{ticketNumber:e.target.value})} placeholder={String(idx+1)} style={inpStyle}/>}
                      </td>
                      <td style={{padding:'4px'}}>
                        {readOnly
                          ?<span style={{padding:'4px 6px',display:'block',fontSize:'12px'}}>{deviceTypes.find(d=>d.id===row.deviceTypeId)?.name||'—'}</span>
                          :<select value={row.deviceTypeId} onChange={e=>updateRow(row._id,{deviceTypeId:e.target.value,deviceModelId:'',repairTypeId:'',addOns:[]})} style={selStyle}><option value="">— select —</option>{deviceTypes.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select>}
                      </td>
                      <td style={{padding:'4px'}}>
                        {readOnly
                          ?<span style={{padding:'4px 6px',display:'block',fontSize:'12px'}}>{deviceModels.find(m=>m.id===row.deviceModelId)?.name||'—'}</span>
                          :<select value={row.deviceModelId} onChange={e=>updateRow(row._id,{deviceModelId:e.target.value,repairTypeId:''})} disabled={!row.deviceTypeId} style={selStyle}><option value="">— select —</option>{modelsForType.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select>}
                      </td>
                      <td style={{padding:'4px'}}>
                        {readOnly
                          ?<span style={{padding:'4px 6px',display:'block',fontSize:'12px'}}>{rt?.name||'—'}</span>
                          :<select value={row.repairTypeId} onChange={e=>updateRow(row._id,{repairTypeId:e.target.value})} disabled={!row.deviceModelId} style={selStyle}><option value="">— select —</option>{repairsForType.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select>}
                      </td>
                      <td style={{padding:'4px',textAlign:'center',fontWeight:700,fontSize:'12px',color:BLUE}}>
                        {editMode
                          ? <BookOverride value={row._bookOverride!=null?row._bookOverride:book} onSave={async v=>{
                              const mins=parseInt(v);
                              if(!isNaN(mins)){
                                setRows(prev=>prev.map(r=>r._id===row._id?{...r,_bookOverride:mins}:r));
                                if(row.dbId){
                                  const actualMins=parseFloat(row.actualMinutes)||null;
                                  const newEff=actualMins&&actualMins>0?Math.round((mins/actualMins)*100):null;
                                  await supabase.from('tickets').update({book_minutes:mins,efficiency_pct:newEff}).eq('id',row.dbId);
                                }
                              }
                            }}/>
                          : (row._bookOverride!=null?row._bookOverride:(book!==null?book:'—'))
                        }
                      </td>
                      <td style={{padding:'4px'}}>
                        {isLabor&&editMode&&(
                          <div style={{display:'flex',alignItems:'center',gap:'3px',marginBottom:'3px'}}>
                            <span style={{fontSize:'10px',color:'#888'}}>$</span>
                            <input type="number" value={row.laborCost} onChange={e=>updateRow(row._id,{laborCost:e.target.value})} placeholder="0" style={{...inpStyle,width:'50px'}}/>
                            <span style={{fontSize:'10px',color:'#888'}}>{baseBook?`= ${baseBook}m`:''}</span>
                          </div>
                        )}
                        {readOnly
                          ?<span style={{padding:'4px 6px',display:'block',fontSize:'12px'}}>{row.actualMinutes||'—'}</span>
                          :<input type="number" value={row.actualMinutes} onChange={e=>updateRow(row._id,{actualMinutes:e.target.value})} placeholder="0" style={inpStyle}/>}
                      </td>
                      <td style={{padding:'4px',textAlign:'center',fontWeight:700,fontSize:'12px',color:diffColor}}>{diff===null?'—':diff>0?`+${diff}`:String(diff)}</td>
                      <td style={{padding:'4px',textAlign:'center'}}>{pct!==null?<span style={{display:'inline-block',fontSize:'11px',fontWeight:700,padding:'2px 7px',borderRadius:'20px',background:rowBg(pct,effG,effY),color:effColor(pct,effG,effY)}}>{pct}%</span>:<span style={{color:'#aac8d8',fontSize:'11px'}}>—</span>}</td>
                      {/* Timer - always read-only, shows live ticking */}
                      <td style={{padding:'4px',minWidth:'110px'}}>
                        <div style={{fontSize:'13px',fontWeight:700,fontVariantNumeric:'tabular-nums',textAlign:'center',padding:'3px 0',background:row.timerState==='running'?GREEN_BG:row.timerState==='paused'?AMBER_BG:'#f5f5f0',borderRadius:'5px',border:`1px solid ${row.timerState==='running'?'#a8dbb8':row.timerState==='paused'?'#fcd98a':BORDER}`,color:row.timerState==='running'?GREEN:row.timerState==='paused'?AMBER:NAVY}}>
                          {fmtTimer(row.timerMs)}
                        </div>
                        <div style={{textAlign:'center',fontSize:'9px',color:'#aaa',marginTop:'2px'}}>
                          {row.timerState==='running'?'▶ Running':row.timerState==='paused'?'⏸ Paused':'Idle'}
                        </div>
                      </td>
                      <td style={{padding:'4px',minWidth:'90px'}}>
                        {editMode&&row.deviceTypeId&&addOnsForType.length>0&&(
                          <div style={{position:'relative'}}>
                            <button onClick={()=>setOpenPopup(openPopup===row._id?null:row._id)} style={{width:'100%',background:(row.addOns||[]).length>0?BLUE_LIGHT:'#fff',border:`1px solid ${(row.addOns||[]).length>0?BORDER:'#d0cdc5'}`,borderRadius:'6px',padding:'3px 6px',fontSize:'10px',fontWeight:600,color:(row.addOns||[]).length>0?BLUE:'#666',cursor:'pointer'}}>
                              {(row.addOns||[]).length>0?`${row.addOns.length} add-on${row.addOns.length>1?'s':''}`:'+ Add-on'}
                            </button>
                            {openPopup===row._id&&(
                              <div style={{position:'absolute',top:'calc(100% + 4px)',left:0,zIndex:200,background:'#fff',border:'1px solid #d0cdc5',borderRadius:'10px',padding:'10px',minWidth:'200px',boxShadow:'0 4px 20px rgba(0,0,0,0.15)'}}>
                                {addOnsForType.map(ao=>{
                                  const checked=(row.addOns||[]).find(a=>a.id===ao.id);
                                  return<div key={ao.id} onClick={()=>toggleAddOn(row._id,ao)} style={{display:'flex',alignItems:'center',gap:'8px',padding:'5px 6px',borderRadius:'6px',cursor:'pointer'}} onMouseEnter={e=>e.currentTarget.style.background='#f5f5f0'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                                    <input type="checkbox" checked={!!checked} onChange={()=>toggleAddOn(row._id,ao)} onClick={e=>e.stopPropagation()}/>
                                    <span style={{flex:1,fontSize:'12px'}}>{ao.name}</span>
                                    <span style={{fontSize:'11px',color:'#888'}}>+{ao.book_minutes}m</span>
                                  </div>;
                                })}
                                <button onClick={()=>setOpenPopup(null)} style={{width:'100%',marginTop:'6px',background:NAVY,color:'#fff',border:'none',borderRadius:'6px',padding:'5px',fontSize:'12px',fontWeight:700,cursor:'pointer'}}>Done</button>
                              </div>
                            )}
                          </div>
                        )}
                        {!editMode&&(row.addOns||[]).length>0&&(
                          <span style={{fontSize:'11px',color:'#888'}}>{row.addOns.length} add-on{row.addOns.length>1?'s':''}</span>
                        )}
                      </td>
                      <td style={{padding:'4px'}}>
                        {readOnly
                          ?<span style={{padding:'4px 6px',display:'block',fontSize:'12px',color:'#666'}}>{row.notes||''}</span>
                          :<input value={row.notes} onChange={e=>updateRow(row._id,{notes:e.target.value})} placeholder="Notes (optional)" style={inpStyle}/>}
                      </td>
                      <td style={{padding:'4px',textAlign:'center',width:'28px'}}>
                        {editMode&&<button onClick={()=>clearRow(row)} title="Remove row" style={{background:'none',border:'none',cursor:'pointer',color:'#ccc',fontSize:'15px',lineHeight:1,padding:'2px'}} onMouseEnter={e=>e.currentTarget.style.color='#b52020'} onMouseLeave={e=>e.currentTarget.style.color='#ccc'}>✕</button>}
                      </td>
                    </tr>
                    {(row.addOns||[]).map(a=>(
                      <tr key={a.id} style={{background:rowBg(pct,effG,effY),opacity:0.8}}>
                        <td/><td/><td/><td style={{padding:'3px 6px'}}><span style={{fontSize:'11px',color:'#666',paddingLeft:'12px'}}>↳ {a.name}</span></td>
                        <td style={{textAlign:'center',fontSize:'11px',color:'#888'}}>+{a.mins}m</td>
                        <td/><td/><td/><td/><td/><td/><td/>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {editMode&&(
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'0.75rem 1rem',borderTop:`1px solid ${BORDER}`}}>
            <button onClick={addRow} style={{background:'#fff',border:`1px solid ${BORDER}`,borderRadius:'8px',padding:'7px 16px',fontSize:'13px',cursor:'pointer',fontFamily:'inherit',color:NAVY}}>+ Add row</button>
            <div style={{fontSize:'12px',color:'#888'}}>Editing {tech.name}'s sheet as Admin</div>
          </div>
        )}
      </div>
    </div>
  );
}

function BookOverride({value,onSave}){
  const[editing,setEditing]=useState(false);
  const[local,setLocal]=useState(value!=null?String(value):'');
  useEffect(()=>{if(!editing)setLocal(value!=null?String(value):'');},[value,editing]);
  if(editing){
    return<input autoFocus type="number" value={local} onChange={e=>setLocal(e.target.value)}
      onBlur={()=>{setEditing(false);if(local.trim()&&local!==String(value))onSave(local);}}
      onKeyDown={e=>{
        if(e.key==='Enter'){setEditing(false);if(local.trim()&&local!==String(value))onSave(local);}
        if(e.key==='Escape'){setEditing(false);setLocal(value!=null?String(value):'');}
      }}
      style={{width:'52px',textAlign:'center',border:'1.5px solid #1B9BD4',borderRadius:'4px',padding:'3px 4px',fontSize:'12px',outline:'none',fontWeight:700,color:'#1a2a3a'}}/>;
  }
  return(
    <span onClick={()=>setEditing(true)} title="Click to override book time for this ticket"
      style={{cursor:'pointer',padding:'2px 6px',borderRadius:'4px',display:'inline-block',minWidth:'32px',border:'1px dashed rgba(27,155,212,0.5)',color:'#1B9BD4'}}
      onMouseEnter={e=>{e.currentTarget.style.background='#e8f6fc';}}
      onMouseLeave={e=>{e.currentTarget.style.background='transparent';}}
    >{value!=null?value:'—'}<span style={{fontSize:'9px',color:'#aac8d8',marginLeft:'2px'}}>✎</span></span>
  );
}

const inpStyle={width:'100%',background:'#fff',border:`1px solid #b8dff0`,borderRadius:'6px',fontSize:'12px',fontFamily:'inherit',color:'#1a2a3a',padding:'4px 6px',outline:'none'};
const selStyle={width:'100%',background:'#fff',border:`1px solid #b8dff0`,borderRadius:'6px',fontSize:'12px',fontFamily:'inherit',color:'#1a2a3a',padding:'4px 6px',outline:'none',cursor:'pointer'};
