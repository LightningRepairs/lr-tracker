import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { clearSettingsCache } from '../lib/settings';
import Reports from './Reports';

const BLUE='#1B9BD4',NAVY='#1a2a3a',BORDER='#b8dff0',GREEN='#2d8a4e',RED='#b52020';

export default function AdminPanel({resetKey}){
  const [tab,setTab]=useState('advanced');
  useEffect(()=>{if(resetKey!==undefined)setTab('advanced');},[resetKey]);
  return(
    <div style={{maxWidth:'1100px',margin:'0 auto'}}>
      <div style={{background:'#fff',borderRadius:'12px',border:`1.5px solid ${BORDER}`,overflow:'hidden'}}>
        <div style={{background:NAVY,padding:'1rem 1.5rem',display:'flex',gap:'8px',alignItems:'center',flexWrap:'wrap'}}>
          <span style={{color:'#fff',fontWeight:700,fontSize:'15px',marginRight:'16px'}}>Admin Panel</span>
          {[['advanced','Advanced Team Overview'],['reports','Reports'],['booktimes','Book Times'],['devices','Devices & Repairs'],['addons','Add-ons'],['technicians','Technicians'],['settings','Settings']].map(([key,label])=>(
            <button key={key} onClick={()=>setTab(key)} style={{background:tab===key?BLUE:'transparent',border:`1px solid ${tab===key?BLUE:'rgba(255,255,255,0.2)'}`,color:tab===key?'#fff':'rgba(255,255,255,0.6)',borderRadius:'6px',padding:'5px 14px',fontSize:'12px',fontWeight:tab===key?700:400,cursor:'pointer'}}>{label}</button>
          ))}
        </div>
        <div style={{padding:'1.5rem'}}>
          {tab==='booktimes'&&<BookTimesEditor/>}
          {tab==='devices'&&<DevicesEditor/>}
          {tab==='addons'&&<AddOnsEditor/>}
          {tab==='technicians'&&<TechniciansEditor/>}
          {tab==='settings'&&<SettingsEditor/>}
          {tab==='reports'&&<Reports/>}
          {tab==='advanced'&&<AdvancedOverview/>}
        </div>
      </div>
    </div>
  );
}

// ── BOOK TIMES ──────────────────────────────────────────────
function BookTimesEditor(){
  const [deviceTypes,setDeviceTypes]=useState([]);
  const [deviceModels,setDeviceModels]=useState([]);
  const [repairTypes,setRepairTypes]=useState([]);
  const [bookTimes,setBookTimes]=useState([]);
  const [selectedType,setSelectedType]=useState('');
  const [saving,setSaving]=useState({});
  const [saved,setSaved]=useState({});

  useEffect(()=>{
    Promise.all([
      supabase.from('device_types').select('*').eq('active',true).order('sort_order'),
      supabase.from('device_models').select('*').eq('active',true).order('sort_order'),
      supabase.from('repair_types').select('*').eq('active',true).order('sort_order'),
      supabase.from('book_times').select('*'),
    ]).then(([dt,dm,rt,bt])=>{setDeviceTypes(dt.data||[]);setDeviceModels(dm.data||[]);setRepairTypes(rt.data||[]);setBookTimes(bt.data||[]);});
  },[]);

  const modelsForType=deviceModels.filter(m=>m.device_type_id===selectedType);
  const repairsForType=repairTypes.filter(r=>r.device_type_id===selectedType&&!r.is_labor);
  const getBookTime=(rid,mid)=>bookTimes.find(b=>b.repair_type_id===rid&&b.device_model_id===mid);

  const updateBookTime=async(rid,mid,value)=>{
    const key=`${rid}_${mid}`;setSaving(s=>({...s,[key]:true}));
    const existing=getBookTime(rid,mid);
    const isNA=value==='N/A'||value==='';const mins=isNA?null:parseInt(value);
    if(existing){await supabase.from('book_times').update({minutes:mins,is_na:isNA,updated_at:new Date().toISOString()}).eq('id',existing.id);setBookTimes(prev=>prev.map(b=>b.id===existing.id?{...b,minutes:mins,is_na:isNA}:b));}
    else{const{data}=await supabase.from('book_times').insert({repair_type_id:rid,device_model_id:mid,minutes:mins,is_na:isNA}).select().single();if(data)setBookTimes(prev=>[...prev,data]);}
    // Update today's tickets that use this repair type + model
    if(!isNA&&mins){
      const today=new Date().toISOString().slice(0,10);
      await supabase.from('tickets').update({book_minutes:mins}).eq('repair_type_id',rid).eq('device_model_id',mid).eq('work_date',today);
    }
    setSaving(s=>({...s,[key]:false}));setSaved(s=>({...s,[key]:true}));setTimeout(()=>setSaved(s=>({...s,[key]:false})),1500);
  };

  return(
    <div>
      <div style={{marginBottom:'1rem',display:'flex',gap:'12px',alignItems:'center',flexWrap:'wrap'}}>
        <div><label style={lbl}>Device type</label><select value={selectedType} onChange={e=>setSelectedType(e.target.value)} style={inp}><option value="">— Select —</option>{deviceTypes.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
        <div style={{fontSize:'12px',color:'#888',marginTop:'18px'}}>Click any cell to edit. Enter minutes or "N/A".</div>
      </div>
      {selectedType&&modelsForType.length>0&&repairsForType.length>0&&(
        <div style={{overflowX:'auto'}}>
          <table style={{borderCollapse:'collapse',fontSize:'12px',width:'100%'}}>
            <thead><tr style={{background:NAVY}}><th style={{...th,textAlign:'left',width:'180px'}}>Repair Type</th>{modelsForType.map(m=><th key={m.id} style={th}>{m.name}</th>)}</tr></thead>
            <tbody>{repairsForType.map((repair,ri)=>(
              <tr key={repair.id} style={{background:ri%2===0?'#f8fbfd':'#fff'}}>
                <td style={{padding:'6px 8px',fontWeight:600,fontSize:'12px',color:NAVY,borderBottom:'1px solid #eef3f7'}}>{repair.name}</td>
                {modelsForType.map(model=>{
                  const bt=getBookTime(repair.id,model.id);const key=`${repair.id}_${model.id}`;
                  const val=bt?.is_na?'N/A':(bt?.minutes!=null?String(bt.minutes):'');
                  return<td key={model.id} style={{padding:'4px',borderBottom:'1px solid #eef3f7',textAlign:'center'}}><BookCell value={val} onSave={v=>updateBookTime(repair.id,model.id,v)} saving={saving[key]} saved={saved[key]}/></td>;
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BookCell({value,onSave,saving,saved}){
  const[editing,setEditing]=useState(false);const[local,setLocal]=useState(value);
  useEffect(()=>{setLocal(value);},[value]);
  if(editing)return<input autoFocus value={local} onChange={e=>setLocal(e.target.value)} onBlur={()=>{setEditing(false);onSave(local);}} onKeyDown={e=>{if(e.key==='Enter'){setEditing(false);onSave(local);}if(e.key==='Escape'){setEditing(false);setLocal(value);}}} style={{width:'60px',textAlign:'center',border:`1.5px solid ${BLUE}`,borderRadius:'4px',padding:'3px 4px',fontSize:'12px',outline:'none'}}/>;
  return<div onClick={()=>setEditing(true)} style={{minWidth:'60px',padding:'4px 8px',textAlign:'center',cursor:'pointer',borderRadius:'4px',border:'1px solid transparent',background:saved?'#e6f5ec':'transparent',color:!value||value==='N/A'?'#ccc':NAVY,fontWeight:value&&value!=='N/A'?600:400}} onMouseEnter={e=>e.currentTarget.style.border=`1px solid ${BLUE}`} onMouseLeave={e=>e.currentTarget.style.border='1px solid transparent'}>{saving?'...':saved?'✓':(value||'—')}</div>;
}

// ── DEVICES & REPAIRS ────────────────────────────────────────
function DevicesEditor(){
  const [deviceTypes,setDeviceTypes]=useState([]);
  const [deviceModels,setDeviceModels]=useState([]);
  const [repairTypes,setRepairTypes]=useState([]);
  const [selectedType,setSelectedType]=useState('');
  const [newTypeName,setNewTypeName]=useState('');
  const [newModel,setNewModel]=useState('');
  const [newRepair,setNewRepair]=useState('');
  const [newRepairDiag,setNewRepairDiag]=useState(false);
  const [newRepairLabor,setNewRepairLabor]=useState(false);
  const [newRepairMult,setNewRepairMult]=useState('0.3');
  const [msg,setMsg]=useState('');
  const dragItem=useRef(null);const dragOver=useRef(null);

  useEffect(()=>{
    Promise.all([
      supabase.from('device_types').select('*').order('sort_order'),
      supabase.from('device_models').select('*').order('sort_order'),
      supabase.from('repair_types').select('*').order('sort_order'),
    ]).then(([dt,dm,rt])=>{setDeviceTypes(dt.data||[]);setDeviceModels(dm.data||[]);setRepairTypes(rt.data||[]);});
  },[]);

  const flash=m=>{setMsg(m);setTimeout(()=>setMsg(''),2500);};
  const[showDisabledTypes,setShowDisabledTypes]=useState(false);
  const[showDisabledModels,setShowDisabledModels]=useState(false);
  const[showDisabledRepairs,setShowDisabledRepairs]=useState(false);

  const deleteItem=async(table,id,setList,confirmMsg)=>{
    if(!window.confirm(confirmMsg))return;
    await supabase.from(table).delete().eq('id',id);
    setList(prev=>prev.filter(x=>x.id!==id));
    flash('Deleted.');
  };

  const addDeviceType=async()=>{
    if(!newTypeName.trim())return;
    const maxOrd=Math.max(0,...deviceTypes.map(d=>d.sort_order));
    const{data}=await supabase.from('device_types').insert({name:newTypeName.trim(),sort_order:maxOrd+1,active:true}).select().single();
    if(data){setDeviceTypes(p=>[...p,data]);setNewTypeName('');flash('Device type added!');}
  };

  const handleDrop=async(list,setList,table,fromId,toId)=>{
    if(fromId===toId)return;
    const sorted=[...list].sort((a,b)=>a.sort_order-b.sort_order);
    const fromIdx=sorted.findIndex(x=>x.id===fromId);
    const toIdx=sorted.findIndex(x=>x.id===toId);
    const reordered=[...sorted];const[moved]=reordered.splice(fromIdx,1);reordered.splice(toIdx,0,moved);
    const updates=reordered.map((item,i)=>({...item,sort_order:i+1}));
    setList(updates);
    await Promise.all(updates.map(item=>supabase.from(table).update({sort_order:item.sort_order}).eq('id',item.id)));
  };

  const updateName=async(table,id,name,setList)=>{
    await supabase.from(table).update({name}).eq('id',id);
    setList(prev=>prev.map(x=>x.id===id?{...x,name}:x));flash('Updated!');
  };

  const toggleActive=async(table,id,current,setList)=>{
    await supabase.from(table).update({active:!current}).eq('id',id);
    setList(prev=>prev.map(x=>x.id===id?{...x,active:!current}:x));
  };

  const addModel=async()=>{
    if(!newModel.trim()||!selectedType)return;
    const list=deviceModels.filter(m=>m.device_type_id===selectedType);
    const maxOrd=Math.max(0,...list.map(m=>m.sort_order));
    const{data}=await supabase.from('device_models').insert({device_type_id:selectedType,name:newModel.trim(),sort_order:maxOrd+1}).select().single();
    if(data){setDeviceModels(p=>[...p,data]);setNewModel('');flash('Model added!');}
  };

  const addRepair=async()=>{
    if(!newRepair.trim()||!selectedType)return;
    const list=repairTypes.filter(r=>r.device_type_id===selectedType);
    const maxOrd=Math.max(0,...list.map(r=>r.sort_order));
    const mult=newRepairLabor?parseFloat(newRepairMult)||0.3:null;
    const name=newRepairLabor?`${newRepair.trim()} (Labor x ${mult})`:newRepair.trim();
    const{data}=await supabase.from('repair_types').insert({device_type_id:selectedType,name,is_diagnosis:newRepairDiag,is_labor:newRepairLabor,labor_multiplier:mult,sort_order:maxOrd+1}).select().single();
    if(data){setRepairTypes(p=>[...p,data]);setNewRepair('');flash('Repair type added!');}
  };

  const sortedTypes=[...deviceTypes].filter(dt=>showDisabledTypes||dt.active).sort((a,b)=>a.sort_order-b.sort_order);
  const sortedModels=[...deviceModels].filter(m=>m.device_type_id===selectedType&&(showDisabledModels||m.active)).sort((a,b)=>a.sort_order-b.sort_order);
  const sortedRepairs=[...repairTypes].filter(r=>r.device_type_id===selectedType&&(showDisabledRepairs||r.active)).sort((a,b)=>a.sort_order-b.sort_order);

  const DragRow=({item,list,setList,table,children})=>(
    <div draggable onDragStart={()=>{dragItem.current=item.id;}} onDragEnter={()=>{dragOver.current=item.id;}} onDragEnd={()=>handleDrop(list,setList,table,dragItem.current,dragOver.current)} onDragOver={e=>e.preventDefault()} style={{display:'flex',alignItems:'center',gap:'6px',padding:'5px 8px',background:item.active?'#f8fbfd':'#fafafa',borderRadius:'6px',marginBottom:'4px',border:'1px solid #eef3f7',cursor:'grab'}}>
      <span style={{color:'#bbb',fontSize:'14px',marginRight:'2px'}}>⠿</span>
      {children}
    </div>
  );

  return(
    <div>
      {msg&&<div style={{background:'#e6f5ec',color:GREEN,borderRadius:'8px',padding:'8px 14px',fontSize:'13px',marginBottom:'1rem'}}>{msg}</div>}

      <div style={{marginBottom:'1.5rem'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'8px'}}>
        <div style={{fontWeight:700,color:NAVY,fontSize:'13px'}}>Device Types <span style={{fontWeight:400,color:'#888',fontSize:'11px'}}>(drag to reorder)</span></div>
        <ToggleSwitch value={showDisabledTypes} onChange={setShowDisabledTypes} label="Show disabled"/>
      </div>
        {sortedTypes.map(dt=>(
          <DragRow key={dt.id} item={dt} list={deviceTypes} setList={setDeviceTypes} table="device_types">
            <InlineEdit value={dt.name} onSave={v=>updateName('device_types',dt.id,v,setDeviceTypes)} active={dt.active}/>
            <button onClick={()=>toggleActive('device_types',dt.id,dt.active,setDeviceTypes)} style={{fontSize:'10px',border:`1px solid ${dt.active?'#f0aaaa':'#a8dbb8'}`,background:'transparent',color:dt.active?RED:GREEN,borderRadius:'4px',padding:'2px 6px',cursor:'pointer',whiteSpace:'nowrap'}}>{dt.active?'Disable':'Enable'}</button>
              <button onClick={()=>deleteItem('device_types',dt.id,setDeviceTypes,'Delete this device type? This will also remove all its models, repair types, and book times.')} style={{fontSize:'10px',border:'1px solid #f0aaaa',background:'transparent',color:RED,borderRadius:'4px',padding:'2px 6px',cursor:'pointer',whiteSpace:'nowrap'}}>Delete</button>
          </DragRow>
        ))}
        <div style={{display:'flex',gap:'6px',marginTop:'8px'}}>
          <input value={newTypeName} onChange={e=>setNewTypeName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addDeviceType()} placeholder="New device type..." style={{...inp,flex:1}}/>
          <button onClick={addDeviceType} style={addBtnStyle}>Add</button>
        </div>
      </div>

      <div style={{marginBottom:'1rem'}}><label style={lbl}>Edit models & repairs for</label><select value={selectedType} onChange={e=>setSelectedType(e.target.value)} style={inp}><option value="">— Select device type —</option>{sortedTypes.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></div>

      {selectedType&&(
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'24px'}}>
          <div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'8px'}}>
              <div style={{fontWeight:700,color:NAVY,fontSize:'13px'}}>Models <span style={{fontWeight:400,color:'#888',fontSize:'11px'}}>(drag to reorder)</span></div>
              <ToggleSwitch value={showDisabledModels} onChange={setShowDisabledModels} label="Show disabled"/>
            </div>
            {sortedModels.map(m=>(
              <DragRow key={m.id} item={m} list={deviceModels} setList={setDeviceModels} table="device_models">
                <InlineEdit value={m.name} onSave={v=>updateName('device_models',m.id,v,setDeviceModels)} active={m.active}/>
                <button onClick={()=>toggleActive('device_models',m.id,m.active,setDeviceModels)} style={{fontSize:'10px',border:`1px solid ${m.active?'#f0aaaa':'#a8dbb8'}`,background:'transparent',color:m.active?RED:GREEN,borderRadius:'4px',padding:'2px 6px',cursor:'pointer',whiteSpace:'nowrap'}}>{m.active?'Disable':'Enable'}</button>
                <button onClick={()=>deleteItem('device_models',m.id,setDeviceModels,'Delete this model?')} style={{fontSize:'10px',border:'1px solid #f0aaaa',background:'transparent',color:RED,borderRadius:'4px',padding:'2px 6px',cursor:'pointer',whiteSpace:'nowrap'}}>Delete</button>
              </DragRow>
            ))}
            <div style={{display:'flex',gap:'6px',marginTop:'8px'}}>
              <input value={newModel} onChange={e=>setNewModel(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addModel()} placeholder="New model..." style={{...inp,flex:1}}/>
              <button onClick={addModel} style={addBtnStyle}>Add</button>
            </div>
          </div>
          <div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'8px'}}>
              <div style={{fontWeight:700,color:NAVY,fontSize:'13px'}}>Repair Types <span style={{fontWeight:400,color:'#888',fontSize:'11px'}}>(drag to reorder)</span></div>
              <ToggleSwitch value={showDisabledRepairs} onChange={setShowDisabledRepairs} label="Show disabled"/>
            </div>
            {sortedRepairs.map(r=>(
              <DragRow key={r.id} item={r} list={repairTypes} setList={setRepairTypes} table="repair_types">
                <div style={{flex:1,minWidth:0}}>
                  <InlineEdit value={r.name} onSave={v=>updateName('repair_types',r.id,v,setRepairTypes)} active={r.active}/>
                  <div style={{display:'flex',gap:'4px',marginTop:'2px'}}>
                    {r.is_diagnosis&&<span style={{fontSize:'9px',background:'#e8f6fc',color:BLUE,borderRadius:'4px',padding:'1px 4px'}}>diag</span>}
                    {r.is_labor&&<span style={{fontSize:'9px',background:'#fff3d0',color:'#9a6000',borderRadius:'4px',padding:'1px 4px'}}>labor x {r.labor_multiplier||0.3}</span>}
                  </div>
                </div>
                <button onClick={()=>toggleActive('repair_types',r.id,r.active,setRepairTypes)} style={{fontSize:'10px',border:`1px solid ${r.active?'#f0aaaa':'#a8dbb8'}`,background:'transparent',color:r.active?RED:GREEN,borderRadius:'4px',padding:'2px 6px',cursor:'pointer',whiteSpace:'nowrap'}}>{r.active?'Disable':'Enable'}</button>
                <button onClick={()=>deleteItem('repair_types',r.id,setRepairTypes,'Delete this repair type?')} style={{fontSize:'10px',border:'1px solid #f0aaaa',background:'transparent',color:RED,borderRadius:'4px',padding:'2px 6px',cursor:'pointer',whiteSpace:'nowrap'}}>Delete</button>
              </DragRow>
            ))}
            <div style={{marginTop:'10px',background:'#f8fbfd',borderRadius:'8px',padding:'10px',border:'1px solid #eef3f7'}}>
              <input value={newRepair} onChange={e=>setNewRepair(e.target.value)} placeholder="Repair type name..." style={{...inp,width:'100%',marginBottom:'8px'}}/>
              <div style={{display:'flex',gap:'12px',alignItems:'center',flexWrap:'wrap',marginBottom:'8px'}}>
                <label style={{display:'flex',gap:'4px',alignItems:'center',fontSize:'12px',color:'#555',cursor:'pointer'}}><input type="checkbox" checked={newRepairDiag} onChange={e=>setNewRepairDiag(e.target.checked)}/> Diagnosis</label>
                <label style={{display:'flex',gap:'4px',alignItems:'center',fontSize:'12px',color:'#555',cursor:'pointer'}}><input type="checkbox" checked={newRepairLabor} onChange={e=>setNewRepairLabor(e.target.checked)}/> Labor</label>
                {newRepairLabor&&<div style={{display:'flex',alignItems:'center',gap:'4px'}}><span style={{fontSize:'12px',color:'#555'}}>Multiplier:</span><input type="number" step="0.01" min="0.01" value={newRepairMult} onChange={e=>setNewRepairMult(e.target.value)} style={{...inp,width:'70px'}}/></div>}
              </div>
              <button onClick={addRepair} style={{...addBtnStyle,width:'100%'}}>Add repair type</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ADD-ONS ──────────────────────────────────────────────────
function AddOnsEditor(){
  const [deviceTypes,setDeviceTypes]=useState([]);
  const [addOns,setAddOns]=useState([]);
  const [selectedType,setSelectedType]=useState('');
  const [newName,setNewName]=useState('');
  const [newMins,setNewMins]=useState('');
  const [msg,setMsg]=useState('');
  const dragItem=useRef(null);const dragOver=useRef(null);

  useEffect(()=>{
    Promise.all([
      supabase.from('device_types').select('*').eq('active',true).order('sort_order'),
      supabase.from('add_ons').select('*').order('sort_order'),
    ]).then(([dt,ao])=>{setDeviceTypes(dt.data||[]);setAddOns(ao.data||[]);});
  },[]);

  const flash=m=>{setMsg(m);setTimeout(()=>setMsg(''),2500);};
  const[showDisabledAO,setShowDisabledAO]=useState(false);

  const deleteAddOn=async(id)=>{
    if(!window.confirm('Delete this add-on?'))return;
    await supabase.from('add_ons').delete().eq('id',id);
    setAddOns(prev=>prev.filter(a=>a.id!==id));
    flash('Deleted.');
  };

  const addOnForType=addOns.filter(a=>a.device_type_id===selectedType&&(showDisabledAO||a.active)).sort((a,b)=>a.sort_order-b.sort_order);

  const addAddOn=async()=>{
    if(!newName.trim()||!selectedType||!newMins)return;
    const maxOrd=Math.max(0,...addOnForType.map(a=>a.sort_order));
    const{data}=await supabase.from('add_ons').insert({device_type_id:selectedType,name:newName.trim(),book_minutes:parseInt(newMins)||0,sort_order:maxOrd+1}).select().single();
    if(data){setAddOns(p=>[...p,data]);setNewName('');setNewMins('');flash('Add-on added!');}
  };

  const updateAddOn=async(id,updates)=>{
    await supabase.from('add_ons').update(updates).eq('id',id);
    setAddOns(prev=>prev.map(a=>a.id===id?{...a,...updates}:a));flash('Saved!');
  };

  const handleDrop=async(fromId,toId)=>{
    if(fromId===toId)return;
    const sorted=[...addOnForType];
    const fromIdx=sorted.findIndex(x=>x.id===fromId);const toIdx=sorted.findIndex(x=>x.id===toId);
    const reordered=[...sorted];const[moved]=reordered.splice(fromIdx,1);reordered.splice(toIdx,0,moved);
    const updates=reordered.map((item,i)=>({...item,sort_order:i+1}));
    setAddOns(prev=>{const others=prev.filter(a=>a.device_type_id!==selectedType);return[...others,...updates];});
    await Promise.all(updates.map(item=>supabase.from('add_ons').update({sort_order:item.sort_order}).eq('id',item.id)));
  };

  return(
    <div>
      {msg&&<div style={{background:'#e6f5ec',color:GREEN,borderRadius:'8px',padding:'8px 14px',fontSize:'13px',marginBottom:'1rem'}}>{msg}</div>}
      <div style={{marginBottom:'1rem'}}><label style={lbl}>Device type</label><select value={selectedType} onChange={e=>setSelectedType(e.target.value)} style={inp}><option value="">— Select device type —</option>{deviceTypes.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
      {selectedType&&(
        <div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'8px'}}>
          <div style={{fontWeight:700,color:NAVY,fontSize:'13px'}}>Add-ons <span style={{fontWeight:400,color:'#888',fontSize:'11px'}}>(drag to reorder)</span></div>
          <ToggleSwitch value={showDisabledAO} onChange={setShowDisabledAO} label="Show disabled"/>
        </div>
          {addOnForType.map(a=>(
            <div key={a.id} draggable onDragStart={()=>{dragItem.current=a.id;}} onDragEnter={()=>{dragOver.current=a.id;}} onDragEnd={()=>handleDrop(dragItem.current,dragOver.current)} onDragOver={e=>e.preventDefault()} style={{display:'flex',alignItems:'center',gap:'8px',padding:'6px 10px',background:a.active?'#f8fbfd':'#fafafa',borderRadius:'6px',marginBottom:'4px',border:'1px solid #eef3f7',cursor:'grab'}}>
              <span style={{color:'#bbb',fontSize:'14px'}}>⠿</span>
              <InlineEdit value={a.name} onSave={v=>updateAddOn(a.id,{name:v})} active={a.active}/>
              <div style={{display:'flex',alignItems:'center',gap:'4px'}}>
                <span style={{fontSize:'11px',color:'#888'}}>Book mins:</span>
                <input type="number" value={a.book_minutes} onChange={e=>updateAddOn(a.id,{book_minutes:parseInt(e.target.value)||0})} style={{...inp,width:'60px',textAlign:'center'}}/>
              </div>
              <button onClick={()=>updateAddOn(a.id,{active:!a.active})} style={{fontSize:'10px',border:`1px solid ${a.active?'#f0aaaa':'#a8dbb8'}`,background:'transparent',color:a.active?RED:GREEN,borderRadius:'4px',padding:'2px 6px',cursor:'pointer',whiteSpace:'nowrap'}}>{a.active?'Disable':'Enable'}</button>
              <button onClick={()=>deleteAddOn(a.id)} style={{fontSize:'10px',border:'1px solid #f0aaaa',background:'transparent',color:RED,borderRadius:'4px',padding:'2px 6px',cursor:'pointer',whiteSpace:'nowrap'}}>Delete</button>
            </div>
          ))}
          <div style={{display:'flex',gap:'8px',marginTop:'12px',alignItems:'flex-end',background:'#f8fbfd',padding:'10px',borderRadius:'8px',border:'1px solid #eef3f7'}}>
            <div style={{flex:1}}><label style={lbl}>Name</label><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="e.g. Advanced Cleaning" style={inp}/></div>
            <div><label style={lbl}>Book mins</label><input type="number" value={newMins} onChange={e=>setNewMins(e.target.value)} placeholder="20" style={{...inp,width:'80px'}}/></div>
            <button onClick={addAddOn} style={addBtnStyle}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TECHNICIANS ──────────────────────────────────────────────
function TechniciansEditor(){
  const [technicians,setTechnicians]=useState([]);
  const [newName,setNewName]=useState('');const [newPin,setNewPin]=useState('');const [newRole,setNewRole]=useState('tech');
  const [editing,setEditing]=useState({});const [msg,setMsg]=useState('');

  const[showDisabled,setShowDisabled]=useState(false);
  useEffect(()=>{supabase.from('technicians').select('*').order('name').then(({data})=>setTechnicians(data||[]));},[]); 
  const flash=m=>{setMsg(m);setTimeout(()=>setMsg(''),2000);};
  const deleteTech=async(id,name)=>{
    if(!window.confirm(`Permanently delete ${name}? This will also delete all their ticket history. This cannot be undone.`))return;
    const{data:tickets}=await supabase.from('tickets').select('id').eq('technician_id',id);
    if(tickets&&tickets.length>0){
      const ids=tickets.map(t=>t.id);
      await supabase.from('ticket_add_ons').delete().in('ticket_id',ids);
      await supabase.from('tickets').delete().eq('technician_id',id);
    }
    await supabase.from('technicians').delete().eq('id',id);
    setTechnicians(prev=>prev.filter(t=>t.id!==id));
    flash('Deleted!');
  };
  const addTech=async()=>{if(!newName.trim()||!newPin.trim())return;const dupPin=technicians.find(t=>t.pin===newPin.trim()&&t.active);if(dupPin){flash(`PIN already used by ${dupPin.name}. Choose a different PIN.`);return;}const{data}=await supabase.from('technicians').insert({name:newName.trim(),pin:newPin.trim(),role:newRole}).select().single();if(data){setTechnicians(p=>[...p,data]);setNewName('');setNewPin('');flash('Added!');}};
  const updateTech=async(id,updates)=>{await supabase.from('technicians').update(updates).eq('id',id);setTechnicians(p=>p.map(t=>t.id===id?{...t,...updates}:t));flash('Saved!');};

  return(
    <div>
      {msg&&<div style={{background:'#e6f5ec',color:GREEN,borderRadius:'8px',padding:'8px 14px',fontSize:'13px',marginBottom:'1rem'}}>{msg}</div>}
      <div style={{display:'flex',justifyContent:'flex-end',marginBottom:'12px'}}>
        <ToggleSwitch value={showDisabled} onChange={setShowDisabled} label="Show disabled users"/>
      </div>
      <div style={{fontSize:'12px',color:'#888',marginBottom:'1rem',background:'#f8fbfd',borderRadius:'8px',padding:'10px 14px',border:'1px solid #eef3f7'}}>
        <strong>Roles:</strong> &nbsp;<span style={{color:'#1B9BD4',fontWeight:600}}>Tech</span> — daily sheet only &nbsp;|&nbsp;<span style={{color:'#9a6000',fontWeight:600}}>Keyholder</span> — sheet + team overview &nbsp;|&nbsp;<span style={{color:RED,fontWeight:600}}>Admin</span> — full access
      </div>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:'13px',marginBottom:'1.5rem'}}>
        <thead><tr style={{background:'#f5f5f0'}}>{['Name','PIN','Role','Status','Actions'].map(h=><th key={h} style={{padding:'8px 10px',textAlign:'left',fontSize:'11px',color:'#555',textTransform:'uppercase',letterSpacing:'0.05em',fontWeight:700,borderBottom:'1px solid #e0ddd5'}}>{h}</th>)}</tr></thead>
        <tbody>{technicians.filter(t=>showDisabled||t.active).map(t=>(
          <tr key={t.id} style={{borderBottom:'1px solid #f0ede5'}}>
            <td style={{padding:'8px 10px',fontWeight:600,color:NAVY}}>{t.name}</td>
            <td style={{padding:'8px 10px'}}>{editing[t.id]?<PinEditor onSave={pin=>{if(pin){updateTech(t.id,{pin});}setEditing(p=>({...p,[t.id]:false}));}}/>:<span style={{fontFamily:'monospace',background:'#f0f0f0',padding:'2px 8px',borderRadius:'4px'}}>{'•'.repeat(t.pin?.length||4)}</span>}</td>
            <td style={{padding:'8px 10px'}}><select value={t.role} onChange={e=>updateTech(t.id,{role:e.target.value})} style={{...inp,width:'110px'}}><option value="tech">Tech</option><option value="manager">Keyholder</option><option value="admin">Admin</option></select></td>
            <td style={{padding:'8px 10px'}}><span style={{background:t.active?'#e6f5ec':'#fce8e8',color:t.active?GREEN:RED,borderRadius:'20px',padding:'2px 10px',fontSize:'11px',fontWeight:700}}>{t.active?'Active':'Inactive'}</span></td>
            <td style={{padding:'8px 10px',display:'flex',gap:'6px'}}>
              {!editing[t.id]&&<button onClick={()=>setEditing(p=>({...p,[t.id]:true}))} style={{fontSize:'11px',border:`1px solid ${BLUE}`,background:'transparent',color:BLUE,borderRadius:'4px',padding:'2px 8px',cursor:'pointer'}}>Change PIN</button>}
              <button onClick={()=>updateTech(t.id,{active:!t.active})} style={{fontSize:'11px',border:`1px solid ${t.active?'#f0aaaa':'#a8dbb8'}`,background:'transparent',color:t.active?RED:GREEN,borderRadius:'4px',padding:'2px 8px',cursor:'pointer'}}>{t.active?'Disable':'Enable'}</button>
              <button onClick={()=>deleteTech(t.id,t.name)} style={{fontSize:'11px',border:'1px solid #f0aaaa',background:'transparent',color:RED,borderRadius:'4px',padding:'2px 8px',cursor:'pointer'}}>Delete</button>
            </td>
          </tr>
        ))}</tbody>
      </table>
      <div style={{background:'#f8fbfd',borderRadius:'10px',padding:'1rem',border:`1px solid ${BORDER}`}}>
        <div style={{fontWeight:700,color:NAVY,marginBottom:'12px',fontSize:'13px'}}>Add Technician</div>
        <div style={{display:'flex',gap:'10px',flexWrap:'wrap',alignItems:'flex-end'}}>
          <div><label style={lbl}>Name</label><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Full name" style={inp}/></div>
          <div><label style={lbl}>PIN</label><input value={newPin} onChange={e=>setNewPin(e.target.value)} placeholder="e.g. 1234" maxLength={6} style={{...inp,width:'100px'}}/></div>
          <div><label style={lbl}>Role</label><select value={newRole} onChange={e=>setNewRole(e.target.value)} style={inp}><option value="tech">Tech</option><option value="manager">Keyholder</option><option value="admin">Admin</option></select></div>
          <button onClick={addTech} style={addBtnStyle}>Add</button>
        </div>
      </div>
    </div>
  );
}

// ── SETTINGS ─────────────────────────────────────────────────
function SettingsEditor(){
  const [settings,setSettings]=useState([]);const [saving,setSaving]=useState({});const [saved,setSaved]=useState({});const [loading,setLoading]=useState(true);
  useEffect(()=>{supabase.from('settings').select('*').order('key').then(({data})=>{setSettings(data||[]);setLoading(false);});},[]); 
  const updateSetting=async(key,value)=>{
    setSaving(s=>({...s,[key]:true}));
    await supabase.from('settings').update({value,updated_at:new Date().toISOString()}).eq('key',key);
    setSettings(prev=>prev.map(s=>s.key===key?{...s,value}:s));
    clearSettingsCache();setSaving(s=>({...s,[key]:false}));setSaved(s=>({...s,[key]:true}));setTimeout(()=>setSaved(s=>({...s,[key]:false})),1500);
  };
  const GROUPS=[
    {title:'Efficiency Thresholds',desc:'Controls green/yellow/red color coding.',keys:['efficiency_green','efficiency_yellow']},
    {title:'Sheet Defaults',desc:'Default values for a fresh daily sheet.',keys:['default_rows','default_labor_multiplier','book_time_goal','actual_time_goal','work_day_start','work_day_end','pace_yellow_threshold']},
    {title:'General',desc:'General app settings.',keys:['shop_name']},
  ];
  if(loading)return<div style={{color:'#888',padding:'2rem',textAlign:'center'}}>Loading...</div>;
  return(
    <div>
      <div style={{marginBottom:'1.5rem',background:'#f8fbfd',borderRadius:'10px',padding:'1rem',border:'1px solid #eef3f7'}}>
        <div style={{fontWeight:700,color:NAVY,marginBottom:'8px',fontSize:'13px'}}>Color preview</div>
        <div style={{display:'flex',gap:'10px',alignItems:'center',flexWrap:'wrap'}}>
          {(()=>{const g=parseInt(settings.find(s=>s.key==='efficiency_green')?.value||90);const y=parseInt(settings.find(s=>s.key==='efficiency_yellow')?.value||79);return<>
            <span style={{background:'#e6f5ec',color:'#3B6D11',fontWeight:700,padding:'4px 12px',borderRadius:'20px',fontSize:'12px'}}>{g}–100%+ Green</span>
            <span style={{background:'#fff3d0',color:'#9a6000',fontWeight:700,padding:'4px 12px',borderRadius:'20px',fontSize:'12px'}}>{y}–{g-1}% Yellow</span>
            <span style={{background:'#fce8e8',color:'#b52020',fontWeight:700,padding:'4px 12px',borderRadius:'20px',fontSize:'12px'}}>0–{y-1}% Red</span>
          </>})()}
        </div>
      </div>
      {GROUPS.map(group=>(
        <div key={group.title} style={{marginBottom:'1.5rem'}}>
          <div style={{fontWeight:700,color:NAVY,fontSize:'14px',marginBottom:'4px'}}>{group.title}</div>
          <div style={{fontSize:'12px',color:'#888',marginBottom:'10px'}}>{group.desc}</div>
          {group.keys.map(key=>{const s=settings.find(x=>x.key===key);if(!s)return null;return<SettingRow key={key} setting={s} onSave={v=>updateSetting(key,v)} saving={saving[key]} saved={saved[key]}/>;
          })}
        </div>
      ))}
    </div>
  );
}

function PinEditor({onSave}){
  const[val,setVal]=useState('');
  const save=()=>{if(val.trim())onSave(val.trim());};
  return(
    <div style={{display:'flex',gap:'4px',alignItems:'center'}}>
      <input autoFocus value={val} onChange={e=>setVal(e.target.value)}
        onKeyDown={e=>{if(e.key==='Enter')save();}}
        style={{border:'1.5px solid #1B9BD4',borderRadius:'6px',padding:'4px 8px',fontSize:'13px',outline:'none',fontFamily:'inherit',color:'#1a2a3a',width:'70px',background:'#fff'}}
        placeholder="New PIN" maxLength={6}/>
      <button onClick={save} style={{background:'#1B9BD4',color:'#fff',border:'none',borderRadius:'5px',padding:'4px 8px',fontSize:'11px',fontWeight:700,cursor:'pointer'}}>Save</button>
      <button onClick={()=>onSave(null)} style={{background:'transparent',color:'#888',border:'1px solid #ddd',borderRadius:'5px',padding:'4px 8px',fontSize:'11px',cursor:'pointer'}}>Cancel</button>
    </div>
  );
}

function SettingRow({setting,onSave,saving,saved}){
  const[local,setLocal]=useState(setting.value);useEffect(()=>{setLocal(setting.value);},[setting.value]);
  return(
    <div style={{display:'flex',alignItems:'center',gap:'16px',padding:'10px 14px',background:'#fff',borderRadius:'8px',border:'1px solid #eef3f7',marginBottom:'6px'}}>
      <div style={{flex:1}}><div style={{fontWeight:600,fontSize:'13px',color:NAVY}}>{setting.label}</div><div style={{fontSize:'11px',color:'#888',marginTop:'2px'}}>{setting.description}</div></div>
      <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
        <input value={local} onChange={e=>setLocal(e.target.value)} onBlur={()=>{if(local!==setting.value)onSave(local);}} onKeyDown={e=>{if(e.key==='Enter')onSave(local);}} style={{border:'1.5px solid #d0cdc5',borderRadius:'8px',padding:'6px 10px',fontSize:'13px',outline:'none',fontFamily:'inherit',color:NAVY,width:'140px',textAlign:'right'}}/>
        {saving&&<span style={{fontSize:'12px',color:'#888'}}>Saving...</span>}
        {saved&&<span style={{fontSize:'12px',color:GREEN,fontWeight:700}}>✓ Saved</span>}
      </div>
    </div>
  );
}

function InlineEdit({value,onSave,active}){
  const[editing,setEditing]=useState(false);const[local,setLocal]=useState(value);useEffect(()=>{setLocal(value);},[value]);
  if(editing)return<input autoFocus value={local} onChange={e=>setLocal(e.target.value)} onBlur={()=>{setEditing(false);if(local.trim()&&local!==value)onSave(local.trim());}} onKeyDown={e=>{if(e.key==='Enter'){setEditing(false);if(local.trim()&&local!==value)onSave(local.trim());}if(e.key==='Escape'){setEditing(false);setLocal(value);}}} style={{flex:1,border:`1.5px solid ${BLUE}`,borderRadius:'4px',padding:'2px 6px',fontSize:'12px',outline:'none',minWidth:0}}/>;
  return<span onClick={()=>setEditing(true)} title="Click to rename" style={{flex:1,fontSize:'12px',color:active?NAVY:'#aaa',textDecoration:active?'none':'line-through',cursor:'text',padding:'2px 4px',borderRadius:'4px',minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} onMouseEnter={e=>e.currentTarget.style.background='#e8f6fc'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>{local}</span>;
}

// ── ADVANCED TEAM OVERVIEW ───────────────────────────────────
function AdvancedOverview(){
  const [tickets,setTickets]=useState([]);
  const [ticketAddOns,setTicketAddOns]=useState([]);
  const [technicians,setTechnicians]=useState([]);
  const [repairTypes,setRepairTypes]=useState([]);
  const [deviceTypes,setDeviceTypes]=useState([]);
  const [deviceModels,setDeviceModels]=useState([]);
  const [selectedDate,setSelectedDate]=useState(new Date().toISOString().slice(0,10));
  const [selectedTechs,setSelectedTechs]=useState(new Set(['all']));
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    Promise.all([
      supabase.from('technicians').select('*').eq('active',true).order('name'),
      supabase.from('repair_types').select('*'),
      supabase.from('device_types').select('*'),
      supabase.from('device_models').select('*'),
    ]).then(([tech,rt,dt,dm])=>{
      setTechnicians(tech.data||[]);setRepairTypes(rt.data||[]);
      setDeviceTypes(dt.data||[]);setDeviceModels(dm.data||[]);
    });
  },[]);

  const loadTickets=async()=>{
    setLoading(true);
    const[t,ta]=await Promise.all([
      supabase.from('tickets').select('*').eq('work_date',selectedDate).order('created_at'),
      supabase.from('ticket_add_ons').select('*'),
    ]);
    setTickets(t.data||[]);setTicketAddOns(ta.data||[]);setLoading(false);
  };

  useEffect(()=>{loadTickets();},[selectedDate]);

  useEffect(()=>{
    if(technicians.length>0&&selectedTechs.has('all')){
      setSelectedTechs(new Set(technicians.map(t=>t.id)));
    }
  },[technicians]);

  const toggleTech=(id)=>{
    if(id==='all'){setSelectedTechs(new Set(technicians.map(t=>t.id)));return;}
    setSelectedTechs(prev=>{
      const next=new Set(prev);
      if(next.has(id))next.delete(id);else next.add(id);
      if(next.size===0)return new Set(technicians.map(t=>t.id));
      return next;
    });
  };

  const visibleTechs=technicians.filter(t=>selectedTechs.has(t.id));

  const getTechStats=(techId)=>{
    const tt=tickets.filter(t=>t.technician_id===techId);
    const repaired=tt.filter(t=>{const rt=repairTypes.find(r=>r.id===t.repair_type_id);return rt&&!rt.is_diagnosis&&rt.name!=='Did Not Complete Repair'&&(t.actual_minutes||0)>0;});
    const diagnosed=tt.filter(t=>{const rt=repairTypes.find(r=>r.id===t.repair_type_id);return rt?.is_diagnosis&&rt.name!=='Did Not Complete Diagnosis'&&(t.actual_minutes||0)>0;});
    const timed=tt.filter(t=>t.actual_minutes>0&&t.book_minutes>0);
    const totA=timed.reduce((s,t)=>s+t.actual_minutes,0);
    const totB=timed.reduce((s,t)=>s+t.book_minutes,0);
    const avgEff=timed.length>0?Math.round((totB/totA)*100):null;
    const addOnCount=ticketAddOns.filter(ta=>tt.find(t=>t.id===ta.ticket_id)).length;
    return{tickets:tt,repaired,diagnosed,totA,totB,avgEff,addOnCount};
  };

  const BLUE='#1B9BD4',NAVY='#1a2a3a',YELLOW='#F5C518',BORDER='#b8dff0';
  const GREEN='#2d8a4e',GREEN_BG='#e6f5ec',AMBER='#9a6000',AMBER_BG='#fff3d0',RED='#b52020',RED_BG='#fce8e8';
  const effColor=(pct,g=90,y=79)=>pct===null?'#aac8d8':pct>=g?GREEN:pct>=y?AMBER:RED;
  const effBg=(pct,g=90,y=79)=>pct===null?'rgba(255,255,255,0.1)':pct>=g?GREEN_BG:pct>=y?AMBER_BG:RED_BG;

  return(
    <div>
      {/* Controls */}
      <div style={{display:'flex',gap:'20px',alignItems:'flex-start',flexWrap:'wrap',marginBottom:'1rem',padding:'1rem',background:'#f8fbfd',borderRadius:'10px',border:'1px solid #eef3f7'}}>
        <div><label style={lbl}>Date</label><input type="date" value={selectedDate} onChange={e=>setSelectedDate(e.target.value)} style={inp}/></div>
        <div>
          <label style={lbl}>Technicians</label>
          <div style={{display:'flex',gap:'6px',flexWrap:'wrap',marginTop:'4px'}}>
            <AdvChip label="All" active={selectedTechs.size===technicians.length} onClick={()=>toggleTech('all')}/>
            {technicians.map(t=><AdvChip key={t.id} label={t.name} active={selectedTechs.has(t.id)} onClick={()=>toggleTech(t.id)}/>)}
          </div>
        </div>
      </div>



      {/* Tech cards */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:'12px',marginBottom:'16px'}}>
        {visibleTechs.map(tech=>{
          const{tickets:tt,repaired,diagnosed,totA,totB,avgEff,addOnCount}=getTechStats(tech.id);
          return(
            <div key={tech.id} style={{background:NAVY,borderRadius:'12px',padding:'1rem 1.25rem',border:'1px solid rgba(255,255,255,0.1)'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'10px'}}>
                <div style={{color:'#fff',fontWeight:700,fontSize:'16px'}}>{tech.name}</div>
                <div style={{background:effBg(avgEff),color:avgEff===null?'#aac8d8':effColor(avgEff),fontWeight:800,fontSize:'16px',padding:'3px 12px',borderRadius:'20px'}}>{avgEff===null?'—':`${avgEff}%`}</div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'6px',marginBottom:'8px'}}>
                {[['Repaired',repaired.length],['Diagnosed',diagnosed.length],['Tickets',tt.length]].map(([l,v])=>(
                  <div key={l} style={{background:'rgba(255,255,255,0.05)',borderRadius:'6px',padding:'6px 8px'}}>
                    <div style={{fontSize:'9px',color:'#7aafc8',textTransform:'uppercase',letterSpacing:'0.05em'}}>{l}</div>
                    <div style={{fontSize:'18px',fontWeight:700,color:'#fff'}}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'6px',marginBottom:'6px'}}>
                {[['Book Time',totB>0?`${totB}m`:'—'],['Actual Time',totA>0?`${totA}m`:'—'],['Add-ons',addOnCount]].map(([l,v])=>(
                  <div key={l} style={{background:'rgba(255,255,255,0.05)',borderRadius:'6px',padding:'6px 8px'}}>
                    <div style={{fontSize:'9px',color:'#7aafc8',textTransform:'uppercase',letterSpacing:'0.05em'}}>{l}</div>
                    <div style={{fontSize:'16px',fontWeight:700,color:YELLOW}}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'6px'}}>
                {[['Revenue','—'],['Profit','—'],['Avg / Ticket','—']].map(([l,v])=>(
                  <div key={l} style={{background:'rgba(255,255,255,0.04)',borderRadius:'6px',padding:'6px 8px',border:'1px dashed rgba(255,255,255,0.08)'}}>
                    <div style={{fontSize:'9px',color:'rgba(255,255,255,0.4)',textTransform:'uppercase',letterSpacing:'0.05em'}}>{l}</div>
                    <div style={{fontSize:'15px',fontWeight:700,color:'rgba(255,255,255,0.3)'}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail table */}
      {tickets.filter(t=>selectedTechs.has(t.technician_id)).length>0&&(
        <div style={{background:'#fff',borderRadius:'12px',border:`1.5px solid ${BORDER}`,overflow:'hidden'}}>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:'12px',minWidth:'900px'}}>
              <thead><tr style={{background:NAVY}}>{['Technician','Ticket #','Device','Repair','Book','Actual','Efficiency','Add-ons','Notes'].map(h=><th key={h} style={{padding:'8px',textAlign:'left',fontSize:'10px',color:'#7aafc8',textTransform:'uppercase',letterSpacing:'0.05em',fontWeight:700,borderBottom:`2px solid ${BLUE}`}}>{h}</th>)}</tr></thead>
              <tbody>
                {tickets.filter(t=>selectedTechs.has(t.technician_id)).map(t=>{
                  const tech=technicians.find(x=>x.id===t.technician_id);
                  const rt=repairTypes.find(x=>x.id===t.repair_type_id);
                  const dt=deviceTypes.find(x=>x.id===t.device_type_id);
                  const dm=deviceModels.find(x=>x.id===t.device_model_id);
                  const pct=t.efficiency_pct;
                  const aoCount=ticketAddOns.filter(ta=>ta.ticket_id===t.id).length;
                  const bg=pct===null?'transparent':pct>=90?GREEN_BG:pct>=79?AMBER_BG:RED_BG;
                  return(
                    <tr key={t.id} style={{background:bg,borderBottom:'1px solid #e8f0f5'}}>
                      <td style={{padding:'6px 8px',fontWeight:600,color:NAVY}}>{tech?.name||'—'}</td>
                      <td style={{padding:'6px 8px'}}>{t.ticket_number||'—'}</td>
                      <td style={{padding:'6px 8px'}}>{dt?.name}{dm?` / ${dm.name}`:''}</td>
                      <td style={{padding:'6px 8px'}}>{rt?.name||'—'}</td>
                      <td style={{padding:'6px 8px',fontWeight:700,color:BLUE}}>{t.book_minutes??'—'}</td>
                      <td style={{padding:'6px 8px'}}>{t.actual_minutes??'—'}</td>
                      <td style={{padding:'6px 8px'}}>{pct!==null?<span style={{display:'inline-block',fontSize:'11px',fontWeight:700,padding:'2px 7px',borderRadius:'20px',background:bg,color:pct>=90?GREEN:pct>=79?AMBER:RED}}>{pct}%</span>:'—'}</td>
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

function AdvChip({label,active,onClick}){
  const BLUE='#1B9BD4',BORDER='#b8dff0';
  return<button onClick={onClick} style={{background:active?BLUE:'transparent',border:`1px solid ${active?BLUE:BORDER}`,color:active?'#fff':'#555',borderRadius:'20px',padding:'4px 12px',fontSize:'12px',fontWeight:active?700:400,cursor:'pointer',fontFamily:'inherit'}}>{label}</button>;
}

function ToggleSwitch({value, onChange, label}){
  return(
    <div style={{display:'flex',alignItems:'center',gap:'10px',cursor:'pointer'}} onClick={()=>onChange(!value)}>
      <div style={{position:'relative',width:'44px',height:'24px',background:value?'#2d8a4e':'#ccc',borderRadius:'12px',transition:'background 0.2s',flexShrink:0}}>
        <div style={{position:'absolute',top:'3px',left:value?'23px':'3px',width:'18px',height:'18px',background:'#fff',borderRadius:'50%',transition:'left 0.2s',boxShadow:'0 1px 3px rgba(0,0,0,0.2)'}}/>
      </div>
      <span style={{fontSize:'13px',fontWeight:600,color:value?'#2d8a4e':'#888',userSelect:'none'}}>{label}</span>
    </div>
  );
}

const lbl={display:'block',fontSize:'11px',fontWeight:600,color:'#555',marginBottom:'4px',textTransform:'uppercase',letterSpacing:'0.05em'};
const inp={border:'1.5px solid #d0cdc5',borderRadius:'8px',padding:'7px 10px',fontSize:'13px',outline:'none',fontFamily:'inherit',color:'#1a2a3a',background:'#fff'};
const th={padding:'8px 10px',textAlign:'center',fontSize:'11px',color:'#7aafc8',textTransform:'uppercase',letterSpacing:'0.05em',fontWeight:700,borderBottom:'2px solid #1B9BD4',whiteSpace:'nowrap',minWidth:'80px'};
const addBtnStyle={background:'#1B9BD4',color:'#fff',border:'none',borderRadius:'8px',padding:'8px 16px',fontSize:'13px',fontWeight:700,cursor:'pointer',fontFamily:'inherit'};
