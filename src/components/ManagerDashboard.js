import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import AdminSheetView from './AdminSheetView';
import { getSettings, getDefaults } from '../lib/settings';

const BLUE='#1B9BD4',NAVY='#1a2a3a',YELLOW='#F5C518',BORDER='#b8dff0';
const GREEN='#2d8a4e',GREEN_BG='#e6f5ec',AMBER='#9a6000',AMBER_BG='#fff3d0',RED='#b52020',RED_BG='#fce8e8';
const R_GREEN='#0d5c2a',R_GREEN_BG='#b8f0cc',R_AMBER='#6b3a00',R_AMBER_BG='#fcd97a',R_RED='#7a0a0a',R_RED_BG='#f5aaaa';
const D_GREEN='#5aaa7a',D_GREEN_BG='#edf8f2',D_AMBER='#c08830',D_AMBER_BG='#fef8e8',D_RED='#cc5555',D_RED_BG='#fdf0f0';

function effColor(pct,green=90,yellow=79,isDiag=false){
  if(pct===null||pct===undefined)return'#aac8d8';
  if(isDiag)return pct>=green?D_GREEN:pct>=yellow?D_AMBER:D_RED;
  return pct>=green?R_GREEN:pct>=yellow?R_AMBER:R_RED;
}
function effBg(pct,green=90,yellow=79,isDiag=false){
  if(pct===null||pct===undefined)return'rgba(255,255,255,0.1)';
  if(isDiag)return pct>=green?D_GREEN_BG:pct>=yellow?D_AMBER_BG:D_RED_BG;
  return pct>=green?R_GREEN_BG:pct>=yellow?R_AMBER_BG:R_RED_BG;
}

export default function ManagerDashboard({tech:currentUser, drillTech, setDrillTech}){
  const [tickets,setTickets]=useState([]);
  const [ticketAddOns,setTicketAddOns]=useState([]);
  const [technicians,setTechnicians]=useState([]);
  const [repairTypes,setRepairTypes]=useState([]);
  const [deviceTypes,setDeviceTypes]=useState([]);
  const [deviceModels,setDeviceModels]=useState([]);
  const [addOnOptions,setAddOnOptions]=useState([]);
  const [selectedDate,setSelectedDate]=useState(new Date().toISOString().slice(0,10));
  const [selectedTechs,setSelectedTechs]=useState(new Set(['all']));
  const [settings,setSettings]=useState(getDefaults());
  const [loading,setLoading]=useState(true);


  useEffect(()=>{
    const load=async()=>{
      const s=await getSettings();setSettings(s);
      const[techData,rt,dt,dm,ao]=await Promise.all([
        supabase.from('technicians').select('*').eq('active',true).order('name'),
        supabase.from('repair_types').select('*'),
        supabase.from('device_types').select('*'),
        supabase.from('device_models').select('*'),
        supabase.from('add_ons').select('*'),
      ]);
      setTechnicians(techData.data||[]);setRepairTypes(rt.data||[]);setDeviceTypes(dt.data||[]);
      setDeviceModels(dm.data||[]);setAddOnOptions(ao.data||[]);
    };
    load();
    // Live subscription to technician changes (handles deletes/adds from admin panel)
    const sub=supabase.channel('techs-live')
      .on('postgres_changes',{event:'*',schema:'public',table:'technicians'},async()=>{
        const{data}=await supabase.from('technicians').select('*').eq('active',true).order('name');
        if(data)setTechnicians(data);
      }).subscribe();
    return()=>supabase.removeChannel(sub);
  },[]);

  const loadTickets=useCallback(async()=>{
    setLoading(true);
    const[t,ta]=await Promise.all([
      supabase.from('tickets').select('*').eq('work_date',selectedDate).order('created_at'),
      supabase.from('ticket_add_ons').select('*'),
    ]);
    setTickets(t.data||[]);setTicketAddOns(ta.data||[]);
    // Load daily goals separately so it can't break the main load
    try{
      const{data:dgData}=await supabase.from('technician_daily_goals').select('*').eq('work_date',selectedDate);
      const goalsMap={};(dgData||[]).forEach(g=>{goalsMap[g.technician_id]=g.book_time_goal;});
      setDailyGoals(goalsMap);
    }catch(e){console.warn('Daily goals load failed',e);}
    setLoading(false);
  },[selectedDate]);

  useEffect(()=>{
    loadTickets();
    const sub=supabase.channel('tickets-live').on('postgres_changes',{event:'*',schema:'public',table:'tickets'},loadTickets).subscribe();
    const sub2=supabase.channel('addons-live').on('postgres_changes',{event:'*',schema:'public',table:'ticket_add_ons'},loadTickets).subscribe();
    return()=>{supabase.removeChannel(sub);supabase.removeChannel(sub2);};
  },[loadTickets]);

  const effGreen=parseInt(settings.efficiency_green||90);
  const effYellow=parseInt(settings.efficiency_yellow||79);

  // Initialize full selection when technicians load
  useEffect(()=>{
    if(technicians.length>0&&selectedTechs.has('all')){
      setSelectedTechs(new Set(technicians.map(t=>t.id)));
    }
  },[technicians]);

  const toggleTech=(id)=>{
    if(id==='all'){
      setSelectedTechs(new Set(technicians.map(t=>t.id)));
      return;
    }
    setSelectedTechs(prev=>{
      const next=new Set(prev);
      if(next.has(id))next.delete(id);else next.add(id);
      if(next.size===0)return new Set(technicians.map(t=>t.id));
      return next;
    });
  };

  const visibleTechs=selectedTechs.has('all')?technicians:technicians.filter(t=>selectedTechs.has(t.id));

  const getTechStats=(techId)=>{
    const tt=tickets.filter(t=>t.technician_id===techId);
    const repaired=tt.filter(t=>{const rt=repairTypes.find(r=>r.id===t.repair_type_id);return rt&&!rt.is_diagnosis&&rt.name!=='Did Not Complete Repair'&&(t.actual_minutes||0)>0;});
    const diagnosed=tt.filter(t=>{const rt=repairTypes.find(r=>r.id===t.repair_type_id);return rt?.is_diagnosis&&rt.name!=='Did Not Complete Diagnosis'&&(t.actual_minutes||0)>0;});
    // For efficiency: use all tickets with book time, treat null actual as 0
    const withBook=tt.filter(t=>t.book_minutes>0);
    const totA=withBook.reduce((s,t)=>s+(t.actual_minutes||0),0);
    const totB=withBook.reduce((s,t)=>s+t.book_minutes,0);
    const avgEff=withBook.length>0&&totA>0?Math.round((totB/totA)*100):null;
    const addOnCount=ticketAddOns.filter(ta=>tt.find(t=>t.id===ta.ticket_id)).length;
    return{tickets:tt,repaired,diagnosed,totA,totB,avgEff,addOnCount};
  };

  if(drillTech){
    return<AdminSheetView tech={drillTech} currentUser={currentUser} viewDate={selectedDate} onBack={()=>setDrillTech(null)}/>;
  }

  return(
    <div style={{maxWidth:'1300px',margin:'0 auto'}}>
      <div style={{background:'#fff',borderRadius:'12px',padding:'1rem 1.5rem',marginBottom:'1rem',border:`1.5px solid ${BORDER}`,display:'flex',gap:'20px',alignItems:'flex-start',flexWrap:'wrap'}}>
        <div><label style={lbl}>Date</label><input type="date" value={selectedDate} onChange={e=>setSelectedDate(e.target.value)} style={inp}/></div>
        <div>
          <label style={lbl}>Technicians</label>
          <div style={{display:'flex',gap:'6px',flexWrap:'wrap',marginTop:'4px'}}>
            <TechChip label="All" active={selectedTechs.has('all')||selectedTechs.size===technicians.length} onClick={()=>toggleTech('all')}/>
            {technicians.map(t=><TechChip key={t.id} label={t.name} active={selectedTechs.has(t.id)} onClick={()=>toggleTech(t.id)}/>)}
          </div>
        </div>
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:'12px',alignSelf:'center'}}>
          <button onClick={loadTickets} style={{background:BLUE,color:'#fff',border:'none',borderRadius:'8px',padding:'7px 16px',fontSize:'13px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:'6px'}}>
            <span style={{fontSize:'16px'}}>↻</span> Refresh
          </button>
          <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
            <div style={{width:8,height:8,borderRadius:'50%',background:GREEN,boxShadow:`0 0 0 3px ${GREEN_BG}`}}/>
            <span style={{fontSize:'12px',color:'#666'}}>Live — updates automatically</span>
          </div>
        </div>
      </div>

      {loading&&<div style={{color:'#fff',textAlign:'center',padding:'2rem'}}>Loading...</div>}

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:'12px',marginBottom:'16px'}}>
        {visibleTechs.map(tech=>{
          const{tickets:tt,repaired,diagnosed,totA,totB,avgEff,addOnCount}=getTechStats(tech.id);
          return(
            <div key={tech.id} onClick={()=>setDrillTech(tech)} style={{background:NAVY,borderRadius:'12px',padding:'1rem 1.25rem',border:'1px solid rgba(255,255,255,0.1)',cursor:'pointer',transition:'transform 0.15s'}} onMouseEnter={e=>e.currentTarget.style.transform='scale(1.02)'} onMouseLeave={e=>e.currentTarget.style.transform='scale(1)'}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'10px'}}>
                <div style={{color:'#fff',fontWeight:700,fontSize:'16px'}}>{tech.name}</div>
                <div style={{background:effBg(avgEff,effGreen,effYellow),color:avgEff===null?'#aac8d8':effColor(avgEff,effGreen,effYellow),fontWeight:800,fontSize:'16px',padding:'3px 12px',borderRadius:'20px'}}>{avgEff===null?'—':`${avgEff}%`}</div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'6px',marginBottom:'8px'}}>
                {[['Repaired',repaired.length],['Diagnosed',diagnosed.length],['Tickets',tt.length]].map(([l,v])=>(
                  <div key={l} style={{background:'rgba(255,255,255,0.05)',borderRadius:'6px',padding:'6px 8px'}}>
                    <div style={{fontSize:'9px',color:'#7aafc8',textTransform:'uppercase',letterSpacing:'0.05em'}}>{l}</div>
                    <div style={{fontSize:'18px',fontWeight:700,color:'#fff'}}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'6px'}}>
                {[['Book Time',totB>0?`${totB}m`:'—'],['Actual Time',totA>0?`${totA}m`:'—'],['Add-ons',addOnCount]].map(([l,v])=>(
                  <div key={l} style={{background:'rgba(255,255,255,0.05)',borderRadius:'6px',padding:'6px 8px'}}>
                    <div style={{fontSize:'9px',color:'#7aafc8',textTransform:'uppercase',letterSpacing:'0.05em'}}>{l}</div>
                    <div style={{fontSize:'16px',fontWeight:700,color:YELLOW}}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{marginTop:'8px',fontSize:'11px',color:'rgba(255,255,255,0.35)',textAlign:'center'}}>Click to view live sheet →</div>
              {currentUser?.role==='admin'&&(
                <div onClick={e=>e.stopPropagation()} style={{marginTop:'8px',display:'flex',alignItems:'center',gap:'8px',background:'rgba(255,255,255,0.05)',borderRadius:'6px',padding:'6px 10px'}}>
                  <span style={{fontSize:'10px',color:'rgba(255,255,255,0.5)',textTransform:'uppercase',letterSpacing:'0.05em',whiteSpace:'nowrap'}}>Today's goal</span>
                  <input type="number" defaultValue={dailyGoals[tech.id]||parseInt(settings.book_time_goal||360)}
                    onBlur={async e=>{
                      const val=parseInt(e.target.value);
                      if(!val||val<1)return;
                      await supabase.from('technician_daily_goals').upsert({technician_id:tech.id,work_date:selectedDate,book_time_goal:val},{onConflict:'technician_id,work_date'});
                      setDailyGoals(prev=>({...prev,[tech.id]:val}));
                    }}
                    onKeyDown={e=>e.key==='Enter'&&e.target.blur()}
                    style={{flex:1,background:'rgba(255,255,255,0.1)',border:'1px solid rgba(255,255,255,0.2)',borderRadius:'4px',color:'#fff',fontSize:'12px',fontWeight:700,padding:'3px 6px',textAlign:'center',outline:'none',fontFamily:'inherit'}}
                  />
                  <span style={{fontSize:'10px',color:'rgba(255,255,255,0.5)'}}>min</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {tickets.filter(t=>selectedTechs.has('all')||selectedTechs.has(t.technician_id)).length>0&&(
        <div style={{background:'#fff',borderRadius:'12px',border:`1.5px solid ${BORDER}`,overflow:'hidden'}}>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:'12px',minWidth:'900px'}}>
              <thead><tr style={{background:NAVY}}>{['Technician','Ticket #','Device','Repair','Book','Actual','+/−','Efficiency','Add-ons','Notes'].map(h=><th key={h} style={{padding:'8px',textAlign:'left',fontSize:'10px',color:'#7aafc8',textTransform:'uppercase',letterSpacing:'0.05em',fontWeight:700,borderBottom:`2px solid ${BLUE}`}}>{h}</th>)}</tr></thead>
              <tbody>
                {tickets.filter(t=>selectedTechs.has('all')||selectedTechs.has(t.technician_id)).map(t=>{
                  const tech=technicians.find(x=>x.id===t.technician_id);
                  const rt=repairTypes.find(x=>x.id===t.repair_type_id);
                  const dt=deviceTypes.find(x=>x.id===t.device_type_id);
                  const dm=deviceModels.find(x=>x.id===t.device_model_id);
                  const pct=t.efficiency_pct;const diff=(t.actual_minutes&&t.book_minutes)?t.actual_minutes-t.book_minutes:null;
                  const aoCount=ticketAddOns.filter(ta=>ta.ticket_id===t.id).length;
                  const rtRow=repairTypes.find(x=>x.id===t.repair_type_id);
                  const isDiagRow=rtRow?.is_diagnosis||false;
                  const bg=pct===null?'transparent':isDiagRow?(pct>=effGreen?D_GREEN_BG:pct>=effYellow?D_AMBER_BG:D_RED_BG):(pct>=effGreen?R_GREEN_BG:pct>=effYellow?R_AMBER_BG:R_RED_BG);
                  return(
                    <tr key={t.id} style={{background:bg,borderBottom:'1px solid #e8f0f5',borderLeft:isDiagRow?'4px solid #7aafc8':'4px solid transparent'}}>
                      <td style={{padding:'6px 8px',fontWeight:600,cursor:'pointer',color:BLUE}} onClick={()=>setDrillTech(technicians.find(x=>x.id===t.technician_id))}>{tech?.name||'—'}</td>
                      <td style={{padding:'6px 8px'}}>{t.ticket_number||'—'}</td>
                      <td style={{padding:'6px 8px'}}>{dt?.name}{dm?` / ${dm.name}`:''}</td>
                      <td style={{padding:'6px 8px'}}>{rt?.name||'—'}</td>
                      <td style={{padding:'6px 8px',fontWeight:700,color:BLUE}}>{t.book_minutes??'—'}</td>
                      <td style={{padding:'6px 8px'}}>{t.actual_minutes??'—'}</td>
                      <td style={{padding:'6px 8px',fontWeight:700,color:diff===null?'#aac8d8':diff<=0?GREEN:RED}}>{diff===null?'—':diff>0?`+${diff}`:diff}</td>
                      <td style={{padding:'6px 8px'}}>{pct!==null?<span style={{display:'inline-block',fontSize:'11px',fontWeight:700,padding:'2px 7px',borderRadius:'20px',background:effBg(pct,effGreen,effYellow,isDiagRow),color:effColor(pct,effGreen,effYellow,isDiagRow)}}>{pct}%</span>:'—'}</td>
                      <td style={{padding:'6px 8px',color:'#666'}}>{aoCount>0?aoCount:''}</td>
                      <td style={{padding:'6px 8px',color:'#666',maxWidth:'150px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t.notes||''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function TechChip({label,active,onClick}){
  return<button onClick={onClick} style={{background:active?BLUE:'transparent',border:`1px solid ${active?BLUE:BORDER}`,color:active?'#fff':'#555',borderRadius:'20px',padding:'4px 12px',fontSize:'12px',fontWeight:active?700:400,cursor:'pointer',fontFamily:'inherit',transition:'all 0.15s'}}>{label}</button>;
}

function TechDrillDown({tech,currentUser,repairTypes,deviceTypes,deviceModels,addOnOptions,effGreen,effYellow,onBack}){
  const [liveTickets,setLiveTickets]=useState([]);
  const [liveAddOns,setLiveAddOns]=useState([]);
  const today=new Date().toISOString().slice(0,10);

  const isAdmin = currentUser?.role === 'admin';

  const updateTicketBook=async(ticketId,newMins)=>{
    await supabase.from('tickets').update({book_minutes:parseInt(newMins)}).eq('id',ticketId);
    setLiveTickets(prev=>prev.map(t=>t.id===ticketId?{...t,book_minutes:parseInt(newMins)}:t));
  };

  useEffect(()=>{
    const reload=async()=>{
      const[t,ta]=await Promise.all([
        supabase.from('tickets').select('*').eq('technician_id',tech.id).eq('work_date',today).order('created_at'),
        supabase.from('ticket_add_ons').select('*'),
      ]);
      setLiveTickets(t.data||[]);setLiveAddOns(ta.data||[]);
    };
    reload();
    const sub=supabase.channel(`drill-${tech.id}`).on('postgres_changes',{event:'*',schema:'public',table:'tickets'},reload).subscribe();
    const sub2=supabase.channel(`drill-ao-${tech.id}`).on('postgres_changes',{event:'*',schema:'public',table:'ticket_add_ons'},reload).subscribe();
    return()=>{supabase.removeChannel(sub);supabase.removeChannel(sub2);};
  },[tech.id,today]);

  const dateStr=new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  const filledRows=liveTickets.filter(t=>t.ticket_number);
  const repaired=filledRows.filter(t=>{const rt=repairTypes.find(r=>r.id===t.repair_type_id);return rt&&!rt.is_diagnosis;});
  const diagnosed=filledRows.filter(t=>{const rt=repairTypes.find(r=>r.id===t.repair_type_id);return rt?.is_diagnosis;});
  const timed=liveTickets.filter(t=>t.actual_minutes>0&&t.book_minutes>0);
  const totA=timed.reduce((s,t)=>s+t.actual_minutes,0);
  const totB=timed.reduce((s,t)=>s+t.book_minutes,0);
  const avgEff=timed.length>0?Math.round((totB/totA)*100):null;

  return(
    <div style={{maxWidth:'1300px',margin:'0 auto'}}>
      <div style={{display:'flex',alignItems:'center',gap:'12px',marginBottom:'1rem'}}>
        <button onClick={onBack} style={{background:'#fff',border:`1px solid ${BORDER}`,borderRadius:'8px',padding:'6px 14px',fontSize:'13px',cursor:'pointer',fontFamily:'inherit',color:NAVY}}>← Back to Team Overview</button>
        <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
          <div style={{width:8,height:8,borderRadius:'50%',background:GREEN}}/>
          <span style={{fontSize:'12px',color:'rgba(255,255,255,0.7)'}}>Live — read only</span>
        </div>
      </div>
      <div style={{background:BLUE,borderRadius:'12px 12px 0 0',padding:'0.85rem 1.5rem',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:'12px'}}>
          <div style={{background:NAVY,borderRadius:'10px',padding:'8px 18px',border:'2px solid rgba(255,255,255,0.2)'}}>
            <div style={{fontSize:'10px',fontWeight:700,color:'rgba(255,255,255,0.5)',textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'2px'}}>Technician</div>
            <div style={{fontSize:'20px',fontWeight:800,color:YELLOW}}>{tech.name}</div>
          </div>
          <div style={{background:'rgba(255,255,255,0.15)',borderRadius:'6px',padding:'4px 10px',fontSize:'11px',color:'#fff',fontWeight:600}}>👁 Read-only live view</div>
        </div>
        <div style={{textAlign:'center'}}>
          <div style={{color:'#fff',fontWeight:700,fontSize:'14px',textTransform:'uppercase',letterSpacing:'0.08em'}}>Daily Ticket Tracker</div>
          <div style={{color:'rgba(255,255,255,0.75)',fontSize:'11px',marginTop:'2px'}}>{dateStr}</div>
        </div>
        <div style={{fontSize:'11px',color:'rgba(255,255,255,0.6)'}}>Updates live</div>
      </div>
      <div style={{background:BLUE,padding:'0 1.5rem 0.85rem'}}>
        <div style={{textAlign:'center',marginBottom:'8px'}}>
          <div style={{display:'inline-flex',alignItems:'center',gap:'10px',background:NAVY,border:'1px solid rgba(255,255,255,0.15)',borderRadius:'10px',padding:'6px 20px'}}>
            <span style={{fontSize:'11px',fontWeight:700,color:'rgba(255,255,255,0.6)',textTransform:'uppercase',letterSpacing:'0.1em'}}>Avg Efficiency</span>
            <span style={{fontSize:'20px',fontWeight:800,color:avgEff===null?YELLOW:effColor(avgEff,effGreen,effYellow)}}>{avgEff===null?'—':`${avgEff}%`}</span>
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
      <div style={{background:'#fff',borderRadius:'0 0 12px 12px',border:`1.5px solid ${BORDER}`,borderTop:'none',overflow:'hidden'}}>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:'12px',minWidth:'1000px'}}>
            <thead><tr style={{background:NAVY}}>{['Ticket #','Device Type','Model','Repair Type','Book','Actual','+/− min','Efficiency','Add-ons','Notes'].map(h=><th key={h} style={{padding:'8px 6px',textAlign:'left',fontWeight:700,fontSize:'10px',color:'#7aafc8',textTransform:'uppercase',letterSpacing:'0.05em',borderBottom:`2px solid ${BLUE}`,whiteSpace:'nowrap'}}>{h}</th>)}</tr></thead>
            <tbody>
              {liveTickets.length===0&&<tr><td colSpan={10} style={{padding:'2rem',textAlign:'center',color:'#aaa'}}>No tickets logged yet today.</td></tr>}
              {liveTickets.map((t,idx)=>{
                const rt=repairTypes.find(r=>r.id===t.repair_type_id);
                const dt=deviceTypes.find(d=>d.id===t.device_type_id);
                const dm=deviceModels.find(m=>m.id===t.device_model_id);
                const pct=t.efficiency_pct;
                const diff=(t.actual_minutes&&t.book_minutes)?t.actual_minutes-t.book_minutes:null;
                const addOnsForTicket=liveAddOns.filter(ta=>ta.ticket_id===t.id);
                const addOnNames=addOnsForTicket.map(ta=>{const ao=addOnOptions.find(a=>a.id===ta.add_on_id);return ao?.name||'Add-on';});
                const bg=pct===null?'transparent':pct>=effGreen?GREEN_BG:pct>=effYellow?AMBER_BG:RED_BG;
                return(
                  <tr key={t.id||idx} style={{background:bg,borderBottom:'1px solid #f0ede5'}}>
                    <td style={{padding:'6px'}}>{t.ticket_number||String(idx+1)}</td>
                    <td style={{padding:'6px'}}>{dt?.name||'—'}</td>
                    <td style={{padding:'6px'}}>{dm?.name||'—'}</td>
                    <td style={{padding:'6px'}}>{rt?.name||'—'}</td>
                    <td style={{padding:'6px',fontWeight:700,color:BLUE,textAlign:'center'}}>
                      {isAdmin
                        ? <BookOverride value={t.book_minutes} onSave={v=>updateTicketBook(t.id,v)}/>
                        : (t.book_minutes||'—')
                      }
                    </td>
                    <td style={{padding:'6px',textAlign:'center'}}>{t.actual_minutes||'—'}</td>
                    <td style={{padding:'6px',fontWeight:700,textAlign:'center',color:diff===null?'#aac8d8':diff<=0?GREEN:RED}}>{diff===null?'—':diff>0?`+${diff}`:diff}</td>
                    <td style={{padding:'6px',textAlign:'center'}}>{pct!==null?<span style={{display:'inline-block',fontSize:'11px',fontWeight:700,padding:'2px 7px',borderRadius:'20px',background:pct>=effGreen?GREEN_BG:pct>=effYellow?AMBER_BG:RED_BG,color:effColor(pct,effGreen,effYellow)}}>{pct}%</span>:'—'}</td>
                    <td style={{padding:'6px',fontSize:'11px',color:'#666'}}>{addOnNames.join(', ')||''}</td>
                    <td style={{padding:'6px',color:'#666',maxWidth:'150px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t.notes||''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function BookOverride({value,onSave}){
  const[editing,setEditing]=useState(false);
  const[local,setLocal]=useState(value||'');
  useEffect(()=>{setLocal(value||'');},[value]);
  if(editing){
    return<input autoFocus type="number" value={local} onChange={e=>setLocal(e.target.value)}
      onBlur={()=>{setEditing(false);if(local&&local!==String(value))onSave(local);}}
      onKeyDown={e=>{if(e.key==='Enter'){setEditing(false);if(local&&local!==String(value))onSave(local);}if(e.key==='Escape'){setEditing(false);setLocal(value||'');}}}
      style={{width:'52px',textAlign:'center',border:'1.5px solid #1B9BD4',borderRadius:'4px',padding:'3px 4px',fontSize:'12px',outline:'none',fontWeight:700}}/>;
  }
  return(
    <span onClick={()=>setEditing(true)} title="Admin: click to override book time"
      style={{cursor:'pointer',padding:'2px 6px',borderRadius:'4px',display:'inline-block',minWidth:'30px',border:'1px dashed rgba(27,155,212,0.4)'}}
      onMouseEnter={e=>e.currentTarget.style.background='#e8f6fc'}
      onMouseLeave={e=>e.currentTarget.style.background='transparent'}
    >{value||'—'}<span style={{fontSize:'9px',color:'#aac8d8',marginLeft:'3px'}}>✎</span></span>
  );
}

const lbl={display:'block',fontSize:'11px',fontWeight:600,color:'#555',marginBottom:'4px',textTransform:'uppercase',letterSpacing:'0.05em'};
const inp={border:'1.5px solid #d0cdc5',borderRadius:'8px',padding:'7px 10px',fontSize:'13px',outline:'none',fontFamily:'inherit',color:'#1a2a3a',background:'#fff'};
