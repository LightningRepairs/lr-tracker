import React, { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { getSettings, getDefaults } from '../lib/settings';

const BLUE='#1B9BD4',NAVY='#1a2a3a',YELLOW='#F5C518',BLUE_LIGHT='#e8f6fc',BLUE_MID='#cceaf7',BORDER='#b8dff0';
const GREEN='#2d8a4e',GREEN_BG='#e6f5ec',AMBER='#9a6000',AMBER_BG='#fff3d0',RED='#b52020',RED_BG='#fce8e8';
// Rich bold colors for repairs
const R_GREEN='#0d5c2a',R_GREEN_BG='#b8f0cc',R_AMBER='#6b3a00',R_AMBER_BG='#fcd97a',R_RED='#7a0a0a',R_RED_BG='#f5aaaa';
// Soft pastel colors for diagnostics  
const D_GREEN='#5aaa7a',D_GREEN_BG='#edf8f2',D_AMBER='#c08830',D_AMBER_BG='#fef8e8',D_RED='#cc5555',D_RED_BG='#fdf0f0';

function pad(n){return String(n).padStart(2,'0');}
function fmtTimer(ms){const t=Math.floor(ms/1000),m=Math.floor(t/60),s=t%60,cs=Math.floor((ms%1000)/10);return`${pad(m)}:${pad(s)}:${pad(cs)}`;}
function effColor(pct,green=90,yellow=79,isDiag=false){
  if(pct===null)return'#aac8d8';
  if(isDiag)return pct>=green?D_GREEN:pct>=yellow?D_AMBER:D_RED;
  return pct>=green?R_GREEN:pct>=yellow?R_AMBER:R_RED;
}
function rowBg(pct,green=90,yellow=79,isDiag=false){
  if(pct===null)return'transparent';
  if(isDiag)return pct>=green?D_GREEN_BG:pct>=yellow?D_AMBER_BG:D_RED_BG;
  return pct>=green?R_GREEN_BG:pct>=yellow?R_AMBER_BG:R_RED_BG;
}

const EMPTY_ROW=()=>({_id:Math.random().toString(36).slice(2),dbId:null,ticketNumber:'',deviceTypeId:'',deviceModelId:'',repairTypeId:'',actualMinutes:'',laborCost:'',isFullSet:false,notes:'',addOns:[],timerMs:0,timerState:'idle',timerStart:null});

export default function TechSheet({tech}){
  const [rows,setRows]=useState(()=>Array.from({length:10},EMPTY_ROW));
  const [deviceTypes,setDeviceTypes]=useState([]);
  const [deviceModels,setDeviceModels]=useState([]);
  const [repairTypes,setRepairTypes]=useState([]);
  const [bookTimes,setBookTimes]=useState([]);
  const [addOnOptions,setAddOnOptions]=useState([]);
  const [loading,setLoading]=useState(true);
  const [settings,setSettings]=useState({...getDefaults(),book_time_goal:'360',actual_time_goal:'360'});
  const [openPopup,setOpenPopup]=useState(null);
  const timerRefs=useRef({});
  const today=new Date().toISOString().slice(0,10);

  useEffect(()=>{
    const load=async()=>{
      const s=await getSettings();
      setSettings(s);
      const[dt,dm,rt,bt,ao]=await Promise.all([
        supabase.from('device_types').select('*').eq('active',true).order('sort_order'),
        supabase.from('device_models').select('*').eq('active',true).order('sort_order'),
        supabase.from('repair_types').select('*').eq('active',true).order('sort_order'),
        supabase.from('book_times').select('*'),
        supabase.from('add_ons').select('*').eq('active',true).order('sort_order'),
      ]);
      setDeviceTypes(dt.data||[]);
      setDeviceModels(dm.data||[]);
      setRepairTypes(rt.data||[]);
      setBookTimes(bt.data||[]);
      setAddOnOptions(ao.data||[]);
      setLoading(false);
    };
    load();
  },[]);

  useEffect(()=>{
    if(!tech)return;
    supabase.from('tickets').select('*,ticket_add_ons(*)').eq('technician_id',tech.id).eq('work_date',today).order('created_at')
      .then(({data})=>{
        if(data&&data.length>0){
          const loaded=data.map(t=>({
            _id:t.id,dbId:t.id,ticketNumber:t.ticket_number||'',deviceTypeId:t.device_type_id||'',
            deviceModelId:t.device_model_id||'',repairTypeId:t.repair_type_id||'',
            actualMinutes:t.actual_minutes!=null?String(t.actual_minutes):'',
            laborCost:t.labor_cost!=null?String(t.labor_cost):'',isFullSet:t.is_full_set||false,
            notes:t.notes||'',
            addOns:(t.ticket_add_ons||[]).map(ta=>({id:ta.add_on_id,mins:ta.book_minutes,taId:ta.id})),
            timerMs:t.timer_started_at?Date.now()-new Date(t.timer_started_at).getTime():(t.timer_paused_ms||0),
            timerState:t.timer_started_at?'running':(t.timer_paused_ms>0?'paused':'idle'),
            timerStart:t.timer_started_at?new Date(t.timer_started_at).getTime():null,
          }));
          const blanks=Math.max(0,10-loaded.length);
          const allRows=[...loaded,...Array.from({length:blanks},EMPTY_ROW)];
          setRows(allRows);
          // Restart intervals for any running timers
          loaded.forEach(r=>{
            if(r.timerState==='running'&&r.timerStart){
              const startMs=r.timerStart;
              clearInterval(timerRefs.current['timer_'+r._id]);
              timerRefs.current['timer_'+r._id]=setInterval(()=>{
                setRows(p=>p.map(rr=>rr._id===r._id&&rr.timerState==='running'?{...rr,timerMs:Date.now()-startMs}:rr));
              },50);
            }
          });
        }
      });
  },[tech,today]);

  const getBookMinutes=useCallback((repairTypeId,deviceModelId,isFullSet)=>{
    const rt=repairTypes.find(r=>r.id===repairTypeId);
    if(!rt||rt.is_labor)return null;
    const bt=bookTimes.find(b=>b.repair_type_id===repairTypeId&&b.device_model_id===deviceModelId);
    if(!bt||bt.is_na)return null;
    return bt.minutes;
  },[repairTypes,bookTimes]);

  const getLaborBookMinutes=useCallback((repairTypeId,laborCost)=>{
    const rt=repairTypes.find(r=>r.id===repairTypeId);
    if(!rt?.is_labor)return null;
    const cost=parseFloat(laborCost)||0;
    const mult=parseFloat(rt.labor_multiplier)||0.3;
    return cost>0?Math.round(cost*mult):null;
  },[repairTypes]);

  const calcBook=useCallback((row)=>{
    const rt=repairTypes.find(r=>r.id===row.repairTypeId);
    const base=rt?.is_labor?getLaborBookMinutes(row.repairTypeId,row.laborCost):getBookMinutes(row.repairTypeId,row.deviceModelId,row.isFullSet);
    if(base===null)return null;
    const addOnTotal=row.addOns.reduce((s,a)=>s+a.mins,0);
    return base+addOnTotal;
  },[repairTypes,getBookMinutes,getLaborBookMinutes]);

  const calcEfficiency=useCallback((row)=>{
    const book=calcBook(row);
    if(book===null)return null;
    // Treat blank actual as 0 - unfinished tickets drag efficiency down
    const actual=row.actualMinutes===''||row.actualMinutes===null||row.actualMinutes===undefined?0:parseFloat(row.actualMinutes)||0;
    if(actual<=0)return book>0?0:null;
    return Math.round((book/actual)*100);
  },[calcBook]);

  const saveRow=useCallback(async(row)=>{
    if(!row.ticketNumber&&!row.deviceTypeId&&!row.repairTypeId&&row.addOns.length===0)return;
    const rt=repairTypes.find(r=>r.id===row.repairTypeId);
    const base=rt?.is_labor?getLaborBookMinutes(row.repairTypeId,row.laborCost):getBookMinutes(row.repairTypeId,row.deviceModelId,row.isFullSet);
    const actual=parseFloat(row.actualMinutes)||null;
    const book=calcBook(row);
    const pct=actual&&book?Math.round((book/actual)*100):null;
    const payload={technician_id:tech.id,ticket_number:row.ticketNumber||null,device_type_id:row.deviceTypeId||null,device_model_id:row.deviceModelId||null,repair_type_id:row.repairTypeId||null,book_minutes:book,actual_minutes:actual,labor_cost:parseFloat(row.laborCost)||null,is_full_set:row.isFullSet,notes:row.notes||null,efficiency_pct:pct,work_date:today};
    let ticketId=row.dbId;
    if(row.dbId){
      await supabase.from('tickets').update(payload).eq('id',row.dbId);
    }else{
      const{data}=await supabase.from('tickets').insert(payload).select().single();
      if(data){ticketId=data.id;setRows(prev=>prev.map(r=>r._id===row._id?{...r,dbId:data.id}:r));}
    }
    if(ticketId){
      await supabase.from('ticket_add_ons').delete().eq('ticket_id',ticketId);
      if(row.addOns.length>0){
        await supabase.from('ticket_add_ons').insert(row.addOns.map(a=>({ticket_id:ticketId,add_on_id:a.id,book_minutes:a.mins})));
      }
    }
  },[tech,today,repairTypes,getBookMinutes,getLaborBookMinutes,calcBook]);

  const updateRow=useCallback((id,updates)=>{
    setRows(prev=>prev.map(r=>{
      if(r._id!==id)return r;
      const updated={...r,...updates};
      clearTimeout(timerRefs.current['save_'+id]);
      timerRefs.current['save_'+id]=setTimeout(()=>saveRow(updated),800);
      return updated;
    }));
  },[saveRow]);

  const timerStart=(id)=>{
    const now=Date.now();
    setRows(prev=>{
      // Auto-pause any currently running timer
      const updated=prev.map(r=>{
        if(r._id===id||r.timerState!=='running')return r;
        clearInterval(timerRefs.current['timer_'+r._id]);
        if(r.dbId){
          supabase.from('tickets').update({timer_started_at:null,timer_paused_ms:r.timerMs}).eq('id',r.dbId).then(()=>{});
        }
        return{...r,timerState:'paused'};
      });
      return updated.map(r=>{
        if(r._id!==id||r.timerState==='running')return r;
        const startMs=now-r.timerMs;
        const startedAt=new Date(startMs).toISOString();
        clearInterval(timerRefs.current['timer_'+id]);
        timerRefs.current['timer_'+id]=setInterval(()=>{
          setRows(p=>p.map(rr=>rr._id===id&&rr.timerState==='running'?{...rr,timerMs:Date.now()-startMs}:rr));
        },50);
        // Save timer_started_at - clear all others for this tech first, then set this one
        const ensureTimerSaved=async()=>{
          // First: clear ALL running timers for this tech today (prevents multiple running timers)
          await supabase.from('tickets')
            .update({timer_started_at:null})
            .eq('technician_id',tech.id)
            .eq('work_date',today)
            .not('timer_started_at','is',null);
          let dbId=r.dbId;
          if(!dbId){
            const{data}=await supabase.from('tickets').insert({
              technician_id:tech.id,work_date:today,
              device_type_id:r.deviceTypeId||null,
              timer_started_at:startedAt,timer_paused_ms:0
            }).select().single();
            if(data){
              dbId=data.id;
              setRows(p=>p.map(rr=>rr._id===id?{...rr,dbId:data.id}:rr));
            }
          } else {
            await supabase.from('tickets').update({timer_started_at:startedAt,timer_paused_ms:0}).eq('id',dbId);
          }
        };
        ensureTimerSaved();
        return{...r,timerState:'running',timerStart:startMs};
      });
    });
  };
  const timerPause=async(id)=>{
    clearInterval(timerRefs.current['timer_'+id]);
    // Get current row state before updating
    setRows(prev=>{
      const row=prev.find(r=>r._id===id);
      if(row?.dbId){
        // Fire and await the DB update outside setRows
        supabase.from('tickets').update({timer_started_at:null,timer_paused_ms:row.timerMs}).eq('id',row.dbId).then(()=>{});
      }
      return prev.map(r=>r._id===id?{...r,timerState:'paused'}:r);
    });
  };
  const timerStop=(id)=>{
    clearInterval(timerRefs.current['timer_'+id]);
    setRows(prev=>prev.map(r=>{
      if(r._id!==id)return r;
      const mins=r.timerMs>0?Math.max(1,Math.round(r.timerMs/60000)):0;
      const updated={...r,timerState:'logged',actualMinutes:mins>0?String(mins):r.actualMinutes};
      if(r.dbId)supabase.from('tickets').update({timer_started_at:null,timer_paused_ms:0}).eq('id',r.dbId);
      clearTimeout(timerRefs.current['save_'+id]);
      timerRefs.current['save_'+id]=setTimeout(()=>saveRow(updated),800);
      return updated;
    }));
  };

  const timerReset=(id)=>{
    clearInterval(timerRefs.current['timer_'+id]);
    setRows(prev=>prev.map(r=>r._id!==id?r:{...r,timerState:'idle',timerMs:0,timerStart:null}));
  };

  const toggleAddOn=(rowId,ao)=>{
    setRows(prev=>prev.map(r=>{
      if(r._id!==rowId)return r;
      const exists=r.addOns.find(a=>a.id===ao.id);
      const newAddOns=exists?r.addOns.filter(a=>a.id!==ao.id):[...r.addOns,{id:ao.id,mins:ao.book_minutes,name:ao.name}];
      const updated={...r,addOns:newAddOns};
      clearTimeout(timerRefs.current['save_'+rowId]);
      timerRefs.current['save_'+rowId]=setTimeout(()=>saveRow(updated),800);
      return updated;
    }));
  };

  const addRow=()=>setRows(prev=>[...prev,EMPTY_ROW()]);
  const clearAll=async()=>{
    if(!window.confirm('Clear all rows for today? This cannot be undone.'))return;
    Object.values(timerRefs.current).forEach(clearInterval);
    timerRefs.current={};
    const{data:todayTickets}=await supabase.from('tickets').select('id').eq('technician_id',tech.id).eq('work_date',today);
    if(todayTickets&&todayTickets.length>0){
      const ids=todayTickets.map(t=>t.id);
      await supabase.from('ticket_add_ons').delete().in('ticket_id',ids);
      await supabase.from('tickets').delete().eq('technician_id',tech.id).eq('work_date',today);
    }
    setRows(Array.from({length:parseInt(settings.default_rows||10)},EMPTY_ROW));
    setOpenPopup(null);
  };

  const clearRow=async(row)=>{
    if(!window.confirm('Remove this row? This cannot be undone.'))return;
    if(row.timerState==='running'||row.timerState==='paused'){
      clearInterval(timerRefs.current['timer_'+row._id]);
    }
    if(row.dbId){
      await supabase.from('ticket_add_ons').delete().eq('ticket_id',row.dbId);
      await supabase.from('tickets').delete().eq('id',row.dbId);
    }
    setRows(prev=>prev.filter(r=>r._id!==row._id));
    if(openPopup===row._id)setOpenPopup(null);
  };

  const effGreen=parseInt(settings.efficiency_green||90);
  const effYellow=parseInt(settings.efficiency_yellow||79);

  const filledRows=rows.filter(r=>r.ticketNumber);
  const repaired=filledRows.filter(r=>{const rt=repairTypes.find(x=>x.id===r.repairTypeId);return rt&&!rt.is_diagnosis&&rt.name!=='Did Not Complete Repair'&&(parseFloat(r.actualMinutes)||0)>0;});
  const diagnosed=filledRows.filter(r=>{const rt=repairTypes.find(x=>x.id===r.repairTypeId);return rt?.is_diagnosis&&rt.name!=='Did Not Complete Diagnosis'&&(parseFloat(r.actualMinutes)||0)>0;});
  const timedRows=rows.filter(r=>{const a=parseFloat(r.actualMinutes)||0;return a>0&&calcBook(r)!==null;});
  const totalActual=timedRows.reduce((s,r)=>s+(parseFloat(r.actualMinutes)||0),0);
  const totalBook=timedRows.reduce((s,r)=>s+(calcBook(r)||0),0);
  const avgEff=timedRows.length>0?Math.round((totalBook/totalActual)*100):null;
  const dateStr=new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});

  if(loading)return<div style={{color:'#fff',textAlign:'center',padding:'3rem'}}>Loading...</div>;

  return(
    <div style={{maxWidth:'1400px',margin:'0 auto'}}>
      <div style={{background:BLUE,borderRadius:'12px 12px 0 0',padding:'0.85rem 1.5rem',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:'12px'}}>
          <div style={{background:NAVY,borderRadius:'10px',padding:'8px 18px',border:'2px solid rgba(255,255,255,0.2)'}}>
            <div style={{fontSize:'10px',fontWeight:700,color:'rgba(255,255,255,0.5)',textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'2px'}}>Technician</div>
            <div style={{fontSize:'20px',fontWeight:800,color:YELLOW,letterSpacing:'0.02em'}}>{tech.name}</div>
          </div>
        </div>
        <div style={{textAlign:'center'}}>
          <div style={{color:'#fff',fontWeight:700,fontSize:'14px',textTransform:'uppercase',letterSpacing:'0.08em'}}>Daily Ticket Tracker</div>
          <div style={{color:'rgba(255,255,255,0.75)',fontSize:'11px',marginTop:'2px'}}>{dateStr}</div>
        </div>
        <div style={{fontSize:'11px',color:'rgba(255,255,255,0.6)'}}>Auto-saves</div>
      </div>
      <div style={{background:BLUE,padding:'0 1.5rem 0.85rem'}}>
        <div style={{textAlign:'center',marginBottom:'8px'}}>
          <div style={{display:'inline-flex',alignItems:'center',gap:'10px',background:NAVY,border:'1px solid rgba(255,255,255,0.15)',borderRadius:'10px',padding:'6px 20px'}}>
            <span style={{fontSize:'11px',fontWeight:700,color:'rgba(255,255,255,0.6)',textTransform:'uppercase',letterSpacing:'0.1em'}}>Avg Efficiency</span>
            <span style={{fontSize:'20px',fontWeight:800,color:avgEff===null?YELLOW:effColor(avgEff,effGreen,effYellow,false)}}>{avgEff===null?'—':`${avgEff}%`}</span>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:'10px'}}>
          {[['Total Repaired',repaired.length],['Total Diagnosed',diagnosed.length],['Total Tickets',filledRows.length],['Book Time',totalBook>0?`${totalBook}m`:'—'],['Actual Time',totalActual>0?`${totalActual}m`:'—']].map(([label,val])=>(
            <div key={label} style={{background:NAVY,borderRadius:'8px',padding:'0.65rem 0.85rem',border:'1px solid rgba(255,255,255,0.1)'}}>
              <div style={{fontSize:'10px',color:'rgba(255,255,255,0.85)',textTransform:'uppercase',letterSpacing:'0.05em',fontWeight:700,marginBottom:'3px'}}>{label}</div>
              <div style={{fontSize:'19px',fontWeight:700,color:'#fff'}}>{val}</div>
            </div>
          ))}
        </div>
        {/* Progress bars */}
        {(()=>{
          const bookGoal=parseInt(settings.book_time_goal||360);
          const actualGoal=parseInt(settings.actual_time_goal||360);
          const bookPct=Math.min((totalBook/bookGoal)*100,100);
          const bookOverflow=totalBook>bookGoal;
          return(
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px',marginTop:'10px'}}>
              {/* Book time bar */}
              <div style={{background:NAVY,borderRadius:'8px',padding:'10px 14px',border:'1px solid rgba(255,255,255,0.1)'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'6px'}}>
                  <span style={{fontSize:'10px',fontWeight:700,color:'rgba(255,255,255,0.7)',textTransform:'uppercase',letterSpacing:'0.08em'}}>Book Time Goal</span>
                  <span style={{fontSize:'13px',fontWeight:800,color:bookOverflow?YELLOW:'#fff'}}>{totalBook}<span style={{color:'rgba(255,255,255,0.4)',fontWeight:400}}> / {bookGoal}m</span>{bookOverflow&&<span style={{fontSize:'11px',color:YELLOW,marginLeft:'6px'}}>+{totalBook-bookGoal}m</span>}</span>
                </div>
                <div style={{height:'10px',background:'rgba(255,255,255,0.1)',borderRadius:'5px',overflow:'hidden'}}>
                  <div style={{height:'100%',width:`${bookPct}%`,background:bookOverflow?YELLOW:BLUE,borderRadius:'5px',transition:'width 0.4s ease'}}/>
                </div>
              </div>
              {/* Actual time tracker */}
              <div style={{background:NAVY,borderRadius:'8px',padding:'10px 14px',border:'1px solid rgba(255,255,255,0.1)'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'6px'}}>
                  <span style={{fontSize:'10px',fontWeight:700,color:'rgba(255,255,255,0.7)',textTransform:'uppercase',letterSpacing:'0.08em'}}>Active Time</span>
                  <span style={{fontSize:'13px',fontWeight:800,color:'#fff'}}>{totalActual}<span style={{color:'rgba(255,255,255,0.4)',fontWeight:400}}> / {actualGoal}m</span></span>
                </div>
                <div style={{height:'10px',background:'rgba(255,255,255,0.1)',borderRadius:'5px',overflow:'hidden'}}>
                  <div style={{height:'100%',width:`${Math.min((totalActual/actualGoal)*100,100)}%`,background:'#4db8e8',borderRadius:'5px',transition:'width 0.4s ease'}}/>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
      <div style={{background:'#fff',borderRadius:'0 0 12px 12px',border:`1.5px solid ${BORDER}`,borderTop:'none',overflow:'hidden'}}>
        <div style={{overflowX:'auto',overflowY:'visible'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:'12px',minWidth:'1200px',overflow:'visible'}}>
            <thead>
              <tr style={{background:NAVY}}>
                {['Ticket #','Device Type','Model','Repair Type','Book','Actual (min)','Efficiency','Timer','Add-ons','Notes',''].map((h,hi)=>(
                  <th key={h} style={{padding:'8px 6px',textAlign:hi===0?'left':'center',fontWeight:700,fontSize:'10px',color:'#7aafc8',textTransform:'uppercase',letterSpacing:'0.05em',borderBottom:`2px solid ${BLUE}`,whiteSpace:'nowrap'}}>{h}</th>
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
                const isDiag=rt?.is_diagnosis||false;
                const isJoycon=deviceModels.find(m=>m.id===row.deviceModelId)?.name?.includes('Joycon');
                const hasDeviceType=!!row.deviceTypeId;
                const hasModel=!!row.deviceModelId;
                const dimStyle={opacity:0.35,pointerEvents:'none'};
                const book=calcBook(row);
                const actual=parseFloat(row.actualMinutes)||0;
                const pct=calcEfficiency(row);
                const diff=(actual>0&&book!==null)?Math.round(actual-book):null;
                const bg=rowBg(pct,effGreen,effYellow,isDiag);
                const diffColor=diff===null?'#aac8d8':diff<=0?GREEN:RED;
                const baseBook=isLabor?getLaborBookMinutes(row.repairTypeId,row.laborCost):getBookMinutes(row.repairTypeId,row.deviceModelId,row.isFullSet);

                return(
                  <React.Fragment key={row._id}>
                    <tr style={{background:bg,borderBottom:`1px solid ${BLUE_MID}`,borderLeft:isDiag?'4px solid #7aafc8':'4px solid transparent'}}>
                      <td style={{padding:'4px'}}><input value={row.ticketNumber} onChange={e=>updateRow(row._id,{ticketNumber:e.target.value})} placeholder={String(idx+1)} style={inpStyle}/></td>
                      <td style={{padding:'4px',textAlign:'center'}}><select value={row.deviceTypeId} onChange={e=>updateRow(row._id,{deviceTypeId:e.target.value,deviceModelId:'',repairTypeId:'',addOns:[]})} style={selStyle}><option value="">— select —</option>{deviceTypes.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></td>
                      <td style={{padding:'4px',textAlign:'center',...(!hasDeviceType?dimStyle:{})}}><select value={row.deviceModelId} onChange={e=>updateRow(row._id,{deviceModelId:e.target.value,repairTypeId:''})} disabled={!row.deviceTypeId} style={!hasDeviceType?selDisabled:selStyle}><option value="">— select —</option>{modelsForType.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></td>
                      <td style={{padding:'4px',textAlign:'center',...(!hasModel?dimStyle:{})}}><select value={row.repairTypeId} onChange={e=>updateRow(row._id,{repairTypeId:e.target.value})} disabled={!row.deviceModelId} style={!hasModel?selDisabled:selStyle}><option value="">— select —</option>{repairsForType.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></td>
                      <td style={{padding:'4px',textAlign:'center',fontWeight:700,fontSize:'12px',color:hasDeviceType?BLUE:'#ccc',...(!hasDeviceType?{opacity:0.4}:{})}}>{book!==null?book:'—'}</td>
                      <td style={{padding:'4px',textAlign:'center',...(!hasDeviceType?dimStyle:{})}}>
                        {isLabor&&<div style={{display:'flex',alignItems:'center',gap:'3px',marginBottom:'3px'}}><span style={{fontSize:'10px',color:'#888'}}>$</span><input type="number" value={row.laborCost} onChange={e=>updateRow(row._id,{laborCost:e.target.value})} placeholder="0" style={{...inpStyle,width:'50px'}}/><span style={{fontSize:'10px',color:'#888'}}>labor{baseBook?` = ${baseBook}m`:''}</span></div>}
                        <input type="number" value={row.actualMinutes} onChange={e=>updateRow(row._id,{actualMinutes:e.target.value})} placeholder={isLabor?'actual mins':'0'} style={!hasDeviceType?inpDisabled:inpStyle}/>
                        {isJoycon&&<div style={{display:'flex',alignItems:'center',gap:'4px',marginTop:'3px'}}><input type="checkbox" checked={row.isFullSet} onChange={e=>updateRow(row._id,{isFullSet:e.target.checked})}/><span style={{fontSize:'11px',color:'#666'}}>full set</span></div>}
                      </td>

                      <td style={{padding:'4px',textAlign:'center'}}>{pct!==null?<span style={{display:'inline-block',fontSize:'11px',fontWeight:700,padding:'2px 7px',borderRadius:'20px',background:rowBg(pct,effGreen,effYellow,isDiag),color:effColor(pct,effGreen,effYellow,isDiag)}}>{pct}%</span>:<span style={{color:'#aac8d8',fontSize:'11px'}}>—</span>}</td>
                      <td style={{padding:'4px',minWidth:'110px',...(!hasDeviceType?{opacity:0.35}:{})}}>
                        <div style={{fontSize:'13px',fontWeight:700,fontVariantNumeric:'tabular-nums',textAlign:'center',padding:'2px 0',background:row.timerState==='running'?GREEN_BG:row.timerState==='paused'?AMBER_BG:row.timerState==='logged'?'#e8f6fc':'#f5f5f0',borderRadius:'5px',border:`1px solid ${row.timerState==='running'?'#a8dbb8':row.timerState==='paused'?'#fcd98a':row.timerState==='logged'?BORDER:BORDER}`,color:row.timerState==='running'?GREEN:row.timerState==='paused'?AMBER:row.timerState==='logged'?BLUE:NAVY,marginBottom:'3px'}}>{fmtTimer(row.timerMs)}</div>
                        {row.timerState==='logged'&&<div style={{fontSize:'9px',color:BLUE,textAlign:'center',marginBottom:'2px',fontWeight:600}}>✓ Logged to actual</div>}
                        <div style={{display:'flex',gap:'3px'}}>
                          {row.timerState==='idle'&&<TBtn color={hasDeviceType?GREEN:'#bbb'} bg={hasDeviceType?GREEN_BG:'#f5f5f0'} border={hasDeviceType?'#a8dbb8':'#e0ddd5'} onClick={()=>hasDeviceType&&timerStart(row._id)}>▶ Start</TBtn>}
                          {row.timerState==='running'&&<><TBtn color={AMBER} bg={AMBER_BG} border="#fcd98a" onClick={()=>timerPause(row._id)}>⏸ Pause</TBtn><TBtn color={BLUE} bg={BLUE_LIGHT} border={BORDER} onClick={()=>timerStop(row._id)}>✓ Log Time</TBtn></>}
                          {row.timerState==='paused'&&<><TBtn color={GREEN} bg={GREEN_BG} border="#a8dbb8" onClick={()=>timerStart(row._id)}>▶ Resume</TBtn><TBtn color={BLUE} bg={BLUE_LIGHT} border={BORDER} onClick={()=>timerStop(row._id)}>✓ Log Time</TBtn></>}
                          {row.timerState==='logged'&&<><TBtn color={GREEN} bg={GREEN_BG} border="#a8dbb8" onClick={()=>timerStart(row._id)}>▶ Resume</TBtn><TBtn color={RED} bg={RED_BG} border="#f0aaaa" onClick={()=>timerReset(row._id)}>✕ Reset</TBtn></>}
                        </div>
                      </td>
                      <td style={{padding:'4px',minWidth:'90px',overflow:'visible',position:'relative',...(!hasDeviceType?dimStyle:{})}}>
                        {row.deviceTypeId&&addOnsForType.length>0&&(
                          <div style={{position:'relative'}}>
                            <button onClick={()=>setOpenPopup(openPopup===row._id?null:row._id)} style={{width:'100%',background:row.addOns.length>0?BLUE_LIGHT:'#fff',border:`1px solid ${row.addOns.length>0?BORDER:'#d0cdc5'}`,borderRadius:'6px',padding:'3px 6px',fontSize:'10px',fontWeight:600,color:row.addOns.length>0?BLUE:'#666',cursor:'pointer'}}>
                              {row.addOns.length>0?`${row.addOns.length} add-on${row.addOns.length>1?'s':''}`:'+ Add-on'}
                            </button>
                            {openPopup===row._id&&(
                              <div style={{position:'absolute',top:'calc(100% + 4px)',right:0,zIndex:999,background:'#fff',border:'1px solid #d0cdc5',borderRadius:'10px',padding:'10px',minWidth:'220px',boxShadow:'0 4px 20px rgba(0,0,0,0.15)'}}>
                                <div style={{fontSize:'11px',fontWeight:700,color:'#888',textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:'6px'}}>Add-on services</div>
                                {addOnsForType.map(ao=>{
                                  const checked=row.addOns.find(a=>a.id===ao.id);
                                  return(
                                    <div key={ao.id} onClick={()=>toggleAddOn(row._id,ao)} style={{display:'flex',alignItems:'center',gap:'8px',padding:'5px 6px',borderRadius:'6px',cursor:'pointer',background:'transparent'}} onMouseEnter={e=>e.currentTarget.style.background='#f5f5f0'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                                      <input type="checkbox" checked={!!checked} onChange={()=>toggleAddOn(row._id,ao)} onClick={e=>e.stopPropagation()}/>
                                      <span style={{flex:1,fontSize:'12px',color:NAVY}}>{ao.name}</span>
                                      <span style={{fontSize:'11px',color:'#888'}}>+{ao.book_minutes}m</span>
                                    </div>
                                  );
                                })}
                                {row.addOns.length>0&&<>
                                  <div style={{height:'1px',background:'#e0ddd5',margin:'8px 0'}}/>
                                  {row.addOns.map(a=><div key={a.id} style={{display:'flex',justifyContent:'space-between',fontSize:'11px',padding:'2px 4px',color:'#666'}}><span>{a.name}</span><span>+{a.mins}m</span></div>)}
                                  <div style={{display:'flex',justifyContent:'space-between',fontSize:'12px',fontWeight:700,color:NAVY,padding:'4px',borderTop:'1px solid #e0ddd5',marginTop:'4px'}}><span>Total book</span><span>{book}m</span></div>
                                </>}
                                <button onClick={()=>setOpenPopup(null)} style={{width:'100%',marginTop:'8px',background:NAVY,color:'#fff',border:'none',borderRadius:'6px',padding:'6px',fontSize:'12px',fontWeight:700,cursor:'pointer'}}>Done</button>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{padding:'4px',textAlign:'center',...(!hasDeviceType?dimStyle:{})}}><input value={row.notes} onChange={e=>updateRow(row._id,{notes:e.target.value})} placeholder="Notes (optional)" style={!hasDeviceType?inpDisabled:inpStyle}/></td>
                      <td style={{padding:'4px',textAlign:'center',width:'28px'}}>
                        <button onClick={()=>clearRow(row)} title="Remove row" style={{background:'none',border:'none',cursor:'pointer',color:'#ccc',fontSize:'15px',lineHeight:1,padding:'2px'}} onMouseEnter={e=>e.currentTarget.style.color='#b52020'} onMouseLeave={e=>e.currentTarget.style.color='#ccc'}>✕</button>
                      </td>
                    </tr>
                    {row.addOns.map(a=>(
                      <tr key={a.id} style={{background:rowBg(pct,effGreen,effYellow),opacity:0.85}}>
                        <td/><td/><td/><td style={{padding:'3px 6px'}}><span style={{fontSize:'11px',color:'#666',paddingLeft:'12px'}}>↳ {a.name}</span></td>
                        <td style={{textAlign:'center',fontSize:'11px',color:'#888'}}>+{a.mins}m</td>
                        <td/><td/><td/><td/><td/><td/>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'0.75rem 1rem',borderTop:`1px solid ${BORDER}`,flexWrap:'wrap',gap:'8px'}}>
          <div style={{display:'flex',gap:'8px'}}>
            <Btn onClick={addRow}>+ Add row</Btn>
            <Btn danger onClick={clearAll}>Clear all</Btn>
          </div>
          <div style={{display:'flex',gap:'14px',alignItems:'center'}}>
            {[[GREEN,'≥'+effGreen+'% On pace'],[AMBER,effYellow+'–'+(effGreen-1)+'% Moderate'],[RED,'<'+effYellow+'% Over book']].map(([c,l])=>(
              <div key={l} style={{display:'flex',alignItems:'center',gap:'5px',fontSize:'11px',color:'#666'}}><div style={{width:9,height:9,borderRadius:'50%',background:c}}/>{l}</div>
            ))}
          </div>
          <Btn primary onClick={()=>window.print()}>⬇ Download PDF</Btn>
        </div>
      </div>
    </div>
  );
}

const inpStyle={width:'100%',background:'#fff',border:'1px solid #b8dff0',borderRadius:'6px',fontSize:'12px',fontFamily:'inherit',color:'#1a2a3a',padding:'4px 6px',outline:'none'};
const inpDisabled={width:'100%',background:'#f5f5f0',border:'1px solid #e0ddd5',borderRadius:'6px',fontSize:'12px',fontFamily:'inherit',color:'#bbb',padding:'4px 6px',outline:'none',cursor:'not-allowed'};
const selDisabled={width:'100%',background:'#f5f5f0',border:'1px solid #e0ddd5',borderRadius:'6px',fontSize:'12px',fontFamily:'inherit',color:'#bbb',padding:'4px 6px',outline:'none',cursor:'not-allowed'};
const selStyle={width:'100%',background:'#fff',border:'1px solid #b8dff0',borderRadius:'6px',fontSize:'12px',fontFamily:'inherit',color:'#1a2a3a',padding:'4px 6px',outline:'none',cursor:'pointer'};
function TBtn({color,bg,border,onClick,children}){return<button onClick={onClick} style={{flex:1,border:`1px solid ${border}`,background:bg,color,borderRadius:'5px',padding:'3px 4px',fontSize:'10px',fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>{children}</button>;}
function Btn({onClick,children,danger,primary}){return<button onClick={onClick} style={{border:`1px solid ${danger?'#f0aaaa':primary?'#1480b0':'#d0cdc5'}`,background:primary?'#1B9BD4':'#fff',color:danger?'#b52020':primary?'#fff':'#1a2a3a',borderRadius:'8px',padding:'7px 16px',fontSize:'13px',fontWeight:primary?700:400,cursor:'pointer',fontFamily:'inherit'}}>{children}</button>;}
