import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

const BLUE='#1B9BD4',NAVY='#1a2a3a',YELLOW='#F5C518',BORDER='#b8dff0';
const GREEN='#2d8a4e',GREEN_BG='#e6f5ec',AMBER='#9a6000',AMBER_BG='#fff3d0',RED='#b52020',RED_BG='#fce8e8';

function effColor(pct){return pct>=90?GREEN:pct>=79?AMBER:RED;}
function effBg(pct){return pct>=90?GREEN_BG:pct>=79?AMBER_BG:RED_BG;}

export default function Reports(){
  const [technicians,setTechnicians]=useState([]);
  const [repairTypes,setRepairTypes]=useState([]);
  const [selectedTechs,setSelectedTechs]=useState(new Set(['all']));
  const [groupBy,setGroupBy]=useState('day');
  const [dateFrom,setDateFrom]=useState(()=>{const d=new Date();d.setDate(1);return d.toISOString().slice(0,10);});
  const [dateTo,setDateTo]=useState(()=>new Date().toISOString().slice(0,10));
  const [data,setData]=useState([]);
  const [loading,setLoading]=useState(false);
  const [generated,setGenerated]=useState(false);
  const reportRef=useRef(null);

  useEffect(()=>{
    Promise.all([
      supabase.from('technicians').select('*').eq('active',true).order('name'),
      supabase.from('repair_types').select('*'),
    ]).then(([t,rt])=>{
      setTechnicians(t.data||[]);
      setRepairTypes(rt.data||[]);
      setSelectedTechs(new Set((t.data||[]).map(x=>x.id)));
    });
  },[]);

  const toggleTech=(id)=>{
    if(id==='all'){setSelectedTechs(new Set(technicians.map(t=>t.id)));return;}
    setSelectedTechs(prev=>{
      const next=new Set(prev);
      if(next.has(id))next.delete(id);else next.add(id);
      if(next.size===0)return new Set(technicians.map(t=>t.id));
      return next;
    });
  };

  const getGroupKey=(date)=>{
    const d=new Date(date+'T12:00:00');
    if(groupBy==='day')return date;
    if(groupBy==='week'){
      const day=d.getDay(),diff=d.getDate()-day+(day===0?-6:1);
      const mon=new Date(d.setDate(diff));
      return mon.toISOString().slice(0,10);
    }
    if(groupBy==='month')return date.slice(0,7);
    return date;
  };

  const groupLabel=(key)=>{
    if(groupBy==='day')return new Date(key+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
    if(groupBy==='week')return `Week of ${new Date(key+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;
    if(groupBy==='month'){const[y,m]=key.split('-');return new Date(y,m-1,1).toLocaleDateString('en-US',{month:'long',year:'numeric'});}
    return key;
  };

  const generateReport=async()=>{
    setLoading(true);setGenerated(false);
    const techIds=[...selectedTechs];
    const{data:tickets}=await supabase.from('tickets').select('*')
      .gte('work_date',dateFrom).lte('work_date',dateTo)
      .in('technician_id',techIds).order('work_date');
    
    const rows=tickets||[];
    
    // Group by period and tech
    const periods={};
    rows.forEach(t=>{
      const key=getGroupKey(t.work_date);
      if(!periods[key])periods[key]={};
      if(!periods[key][t.technician_id])periods[key][t.technician_id]={tickets:[],techId:t.technician_id};
      periods[key][t.technician_id].tickets.push(t);
    });

    const result=Object.keys(periods).sort().map(period=>{
      const techData=Object.values(periods[period]).map(({techId,tickets:tt})=>{
        const tech=technicians.find(x=>x.id===techId);
        const repaired=tt.filter(t=>{const rt=repairTypes.find(r=>r.id===t.repair_type_id);return rt&&!rt.is_diagnosis&&rt.name!=='Did Not Complete Repair'&&(t.actual_minutes||0)>0;});
        const diagnosed=tt.filter(t=>{const rt=repairTypes.find(r=>r.id===t.repair_type_id);return rt?.is_diagnosis&&rt.name!=='Did Not Complete Diagnosis'&&(t.actual_minutes||0)>0;});
        const timed=tt.filter(t=>t.actual_minutes>0&&t.book_minutes>0);
        const totA=timed.reduce((s,t)=>s+t.actual_minutes,0);
        const totB=timed.reduce((s,t)=>s+t.book_minutes,0);
        const overallEff=totA>0?Math.round((totB/totA)*100):null;
        // Daily efficiency average
        const byDay={};
        timed.forEach(t=>{
          if(!byDay[t.work_date])byDay[t.work_date]={b:0,a:0};
          byDay[t.work_date].b+=t.book_minutes;byDay[t.work_date].a+=t.actual_minutes;
        });
        const dayEffs=Object.values(byDay).map(d=>d.a>0?Math.round((d.b/d.a)*100):null).filter(x=>x!==null);
        const avgDailyEff=dayEffs.length>0?Math.round(dayEffs.reduce((a,b)=>a+b,0)/dayEffs.length):null;
        return{tech,repaired:repaired.length,diagnosed:diagnosed.length,tickets:tt.length,totA,totB,overallEff,avgDailyEff,daysWorked:Object.keys(byDay).length};
      });
      return{period,techData};
    });

    setData(result);setLoading(false);setGenerated(true);
  };

  const exportPDF=()=>{
    const win=window.open('','_blank');
    const html=`<!DOCTYPE html><html><head><title>Lightning Repairs Report</title>
    <style>body{font-family:Arial,sans-serif;padding:24px;color:#1a2a3a;}h1{color:#1B9BD4;margin-bottom:4px;}
    .sub{color:#888;font-size:13px;margin-bottom:24px;}
    table{width:100%;border-collapse:collapse;margin-bottom:32px;font-size:12px;}
    th{background:#1a2a3a;color:#7aafc8;padding:8px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;}
    td{padding:7px 8px;border-bottom:1px solid #eee;}
    tr:hover td{background:#f8fbfd;}
    .period{font-size:14px;font-weight:700;color:#1a2a3a;margin:20px 0 6px;}
    .eff-green{color:#2d8a4e;font-weight:700;}
    .eff-yellow{color:#9a6000;font-weight:700;}
    .eff-red{color:#b52020;font-weight:700;}
    </style></head><body>
    <h1>Lightning Repairs — Report</h1>
    <div class="sub">${dateFrom} to ${dateTo} &nbsp;·&nbsp; Grouped by ${groupBy} &nbsp;·&nbsp; ${[...selectedTechs].length === technicians.length?'All technicians':technicians.filter(t=>selectedTechs.has(t.id)).map(t=>t.name).join(', ')}</div>
    ${data.map(({period,techData})=>`
      <div class="period">${groupLabel(period)}</div>
      <table><thead><tr>
        <th>Technician</th><th>Days Worked</th><th>Tickets</th><th>Repaired</th><th>Diagnosed</th>
        <th>Book Time</th><th>Actual Time</th><th>Overall Eff</th><th>Avg Daily Eff</th>
      </tr></thead><tbody>
      ${techData.map(r=>{
        const ec=r.overallEff===null?'':r.overallEff>=90?'eff-green':r.overallEff>=79?'eff-yellow':'eff-red';
        const ec2=r.avgDailyEff===null?'':r.avgDailyEff>=90?'eff-green':r.avgDailyEff>=79?'eff-yellow':'eff-red';
        return`<tr><td><b>${r.tech?.name||'?'}</b></td><td>${r.daysWorked}</td><td>${r.tickets}</td>
        <td>${r.repaired}</td><td>${r.diagnosed}</td>
        <td>${r.totB>0?r.totB+'m':'—'}</td><td>${r.totA>0?r.totA+'m':'—'}</td>
        <td class="${ec}">${r.overallEff!==null?r.overallEff+'%':'—'}</td>
        <td class="${ec2}">${r.avgDailyEff!==null?r.avgDailyEff+'%':'—'}</td></tr>`;
      }).join('')}
      </tbody></table>
    `).join('')}
    </body></html>`;
    win.document.write(html);
    win.document.close();
    win.print();
  };

  return(
    <div>
      {/* Filters */}
      <div style={{background:'#f8fbfd',borderRadius:'10px',padding:'1rem 1.25rem',border:'1px solid #eef3f7',marginBottom:'1.5rem'}}>
        <div style={{display:'flex',gap:'20px',flexWrap:'wrap',alignItems:'flex-end'}}>
          <div>
            <label style={lbl}>From</label>
            <input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={inp}/>
          </div>
          <div>
            <label style={lbl}>To</label>
            <input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} style={inp}/>
          </div>
          <div>
            <label style={lbl}>Group by</label>
            <select value={groupBy} onChange={e=>setGroupBy(e.target.value)} style={inp}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </div>
          <div>
            <label style={lbl}>Technicians</label>
            <div style={{display:'flex',gap:'5px',flexWrap:'wrap',marginTop:'4px'}}>
              <RChip label="All" active={selectedTechs.size===technicians.length} onClick={()=>toggleTech('all')}/>
              {technicians.map(t=><RChip key={t.id} label={t.name} active={selectedTechs.has(t.id)} onClick={()=>toggleTech(t.id)}/>)}
            </div>
          </div>
          <button onClick={generateReport} disabled={loading} style={{background:NAVY,color:'#fff',border:'none',borderRadius:'8px',padding:'8px 20px',fontSize:'13px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',height:'36px'}}>
            {loading?'Loading...':'Generate Report'}
          </button>
          {generated&&data.length>0&&(
            <button onClick={exportPDF} style={{background:BLUE,color:'#fff',border:'none',borderRadius:'8px',padding:'8px 20px',fontSize:'13px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',height:'36px'}}>
              ⬇ Export PDF
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      {generated&&data.length===0&&<div style={{textAlign:'center',color:'#888',padding:'2rem'}}>No tickets found for the selected period.</div>}
      
      {data.map(({period,techData})=>(
        <div key={period} style={{marginBottom:'1.5rem'}}>
          <div style={{fontWeight:700,color:NAVY,fontSize:'14px',marginBottom:'8px',paddingBottom:'6px',borderBottom:`2px solid ${BLUE}`}}>{groupLabel(period)}</div>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:'12px'}}>
              <thead>
                <tr style={{background:NAVY}}>
                  {['Technician','Days Worked','Tickets','Repaired','Diagnosed','Book Time','Actual Time','Overall Eff','Avg Daily Eff'].map(h=>(
                    <th key={h} style={{padding:'8px',textAlign:'left',fontSize:'10px',color:'#7aafc8',textTransform:'uppercase',letterSpacing:'0.05em',fontWeight:700,borderBottom:`2px solid ${BLUE}`,whiteSpace:'nowrap'}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {techData.map((r,i)=>(
                  <tr key={i} style={{background:i%2===0?'#f8fbfd':'#fff',borderBottom:'1px solid #eef3f7'}}>
                    <td style={{padding:'8px',fontWeight:700,color:NAVY}}>{r.tech?.name||'?'}</td>
                    <td style={{padding:'8px',textAlign:'center'}}>{r.daysWorked}</td>
                    <td style={{padding:'8px',textAlign:'center'}}>{r.tickets}</td>
                    <td style={{padding:'8px',textAlign:'center'}}>{r.repaired}</td>
                    <td style={{padding:'8px',textAlign:'center'}}>{r.diagnosed}</td>
                    <td style={{padding:'8px',textAlign:'center',color:BLUE,fontWeight:700}}>{r.totB>0?`${r.totB}m`:'—'}</td>
                    <td style={{padding:'8px',textAlign:'center'}}>{r.totA>0?`${r.totA}m`:'—'}</td>
                    <td style={{padding:'8px',textAlign:'center'}}>{r.overallEff!==null?<span style={{display:'inline-block',padding:'2px 8px',borderRadius:'20px',fontWeight:700,fontSize:'11px',background:effBg(r.overallEff),color:effColor(r.overallEff)}}>{r.overallEff}%</span>:'—'}</td>
                    <td style={{padding:'8px',textAlign:'center'}}>{r.avgDailyEff!==null?<span style={{display:'inline-block',padding:'2px 8px',borderRadius:'20px',fontWeight:700,fontSize:'11px',background:effBg(r.avgDailyEff),color:effColor(r.avgDailyEff)}}>{r.avgDailyEff}%</span>:'—'}</td>
                  </tr>
                ))}
                {/* Team total row */}
                {techData.length>1&&(()=>{
                  const totT=techData.reduce((s,r)=>s+r.tickets,0);
                  const totR=techData.reduce((s,r)=>s+r.repaired,0);
                  const totD=techData.reduce((s,r)=>s+r.diagnosed,0);
                  const totB=techData.reduce((s,r)=>s+r.totB,0);
                  const totA=techData.reduce((s,r)=>s+r.totA,0);
                  const teamEff=totA>0?Math.round((totB/totA)*100):null;
                  const dayEffs=techData.map(r=>r.avgDailyEff).filter(x=>x!==null);
                  const teamAvgEff=dayEffs.length>0?Math.round(dayEffs.reduce((a,b)=>a+b,0)/dayEffs.length):null;
                  return(
                    <tr style={{background:'#f0f8ff',borderTop:`2px solid ${BLUE}`}}>
                      <td style={{padding:'8px',fontWeight:800,color:NAVY}}>TEAM TOTAL</td>
                      <td style={{padding:'8px',textAlign:'center'}}>—</td>
                      <td style={{padding:'8px',textAlign:'center',fontWeight:700}}>{totT}</td>
                      <td style={{padding:'8px',textAlign:'center',fontWeight:700}}>{totR}</td>
                      <td style={{padding:'8px',textAlign:'center',fontWeight:700}}>{totD}</td>
                      <td style={{padding:'8px',textAlign:'center',color:BLUE,fontWeight:700}}>{totB>0?`${totB}m`:'—'}</td>
                      <td style={{padding:'8px',textAlign:'center',fontWeight:700}}>{totA>0?`${totA}m`:'—'}</td>
                      <td style={{padding:'8px',textAlign:'center'}}>{teamEff!==null?<span style={{display:'inline-block',padding:'2px 8px',borderRadius:'20px',fontWeight:700,fontSize:'11px',background:effBg(teamEff),color:effColor(teamEff)}}>{teamEff}%</span>:'—'}</td>
                      <td style={{padding:'8px',textAlign:'center'}}>{teamAvgEff!==null?<span style={{display:'inline-block',padding:'2px 8px',borderRadius:'20px',fontWeight:700,fontSize:'11px',background:effBg(teamAvgEff),color:effColor(teamAvgEff)}}>{teamAvgEff}%</span>:'—'}</td>
                    </tr>
                  );
                })()}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function RChip({label,active,onClick}){
  return<button onClick={onClick} style={{background:active?BLUE:'transparent',border:`1px solid ${active?BLUE:BORDER}`,color:active?'#fff':'#555',borderRadius:'20px',padding:'3px 10px',fontSize:'11px',fontWeight:active?700:400,cursor:'pointer',fontFamily:'inherit'}}>{label}</button>;
}

const lbl={display:'block',fontSize:'11px',fontWeight:600,color:'#555',marginBottom:'4px',textTransform:'uppercase',letterSpacing:'0.05em'};
const inp={border:'1.5px solid #d0cdc5',borderRadius:'8px',padding:'7px 10px',fontSize:'13px',outline:'none',fontFamily:'inherit',color:'#1a2a3a',background:'#fff'};
