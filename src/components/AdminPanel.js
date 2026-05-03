import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

const BLUE = '#1B9BD4';
const NAVY = '#1a2a3a';
const BORDER = '#b8dff0';
const GREEN = '#2d8a4e';
const RED = '#b52020';

export default function AdminPanel() {
  const [tab, setTab] = useState('booktimes');

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ background: '#fff', borderRadius: '12px', border: `1.5px solid ${BORDER}`, overflow: 'hidden' }}>
        <div style={{ background: NAVY, padding: '1rem 1.5rem', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ color: '#fff', fontWeight: 700, fontSize: '15px', marginRight: '16px' }}>Admin Panel</span>
          {[['booktimes','Book Times'],['devices','Devices & Repairs'],['technicians','Technicians']].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              background: tab === key ? BLUE : 'transparent',
              border: `1px solid ${tab === key ? BLUE : 'rgba(255,255,255,0.2)'}`,
              color: tab === key ? '#fff' : 'rgba(255,255,255,0.6)',
              borderRadius: '6px', padding: '5px 14px', fontSize: '12px',
              fontWeight: tab === key ? 700 : 400, cursor: 'pointer',
            }}>{label}</button>
          ))}
        </div>
        <div style={{ padding: '1.5rem' }}>
          {tab === 'booktimes' && <BookTimesEditor />}
          {tab === 'devices' && <DevicesEditor />}
          {tab === 'technicians' && <TechniciansEditor />}
        </div>
      </div>
    </div>
  );
}

function BookTimesEditor() {
  const [deviceTypes, setDeviceTypes] = useState([]);
  const [deviceModels, setDeviceModels] = useState([]);
  const [repairTypes, setRepairTypes] = useState([]);
  const [bookTimes, setBookTimes] = useState([]);
  const [selectedType, setSelectedType] = useState('');
  const [saving, setSaving] = useState({});
  const [saved, setSaved] = useState({});

  useEffect(() => {
    const load = async () => {
      const [dt, dm, rt, bt] = await Promise.all([
        supabase.from('device_types').select('*').eq('active', true).order('sort_order'),
        supabase.from('device_models').select('*').eq('active', true).order('sort_order'),
        supabase.from('repair_types').select('*').eq('active', true).order('sort_order'),
        supabase.from('book_times').select('*'),
      ]);
      setDeviceTypes(dt.data || []);
      setDeviceModels(dm.data || []);
      setRepairTypes(rt.data || []);
      setBookTimes(bt.data || []);
    };
    load();
  }, []);

  const modelsForType = deviceModels.filter(m => m.device_type_id === selectedType);
  const repairsForType = repairTypes.filter(r => r.device_type_id === selectedType && !r.is_labor);

  const getBookTime = (repairId, modelId) => {
    const bt = bookTimes.find(b => b.repair_type_id === repairId && b.device_model_id === modelId);
    return bt;
  };

  const updateBookTime = async (repairId, modelId, value) => {
    const key = `${repairId}_${modelId}`;
    setSaving(s => ({ ...s, [key]: true }));
    const existing = getBookTime(repairId, modelId);
    const isNA = value === 'N/A' || value === '';
    const mins = isNA ? null : parseInt(value);

    if (existing) {
      await supabase.from('book_times').update({ minutes: mins, is_na: isNA, updated_at: new Date().toISOString() }).eq('id', existing.id);
      setBookTimes(prev => prev.map(b => b.id === existing.id ? { ...b, minutes: mins, is_na: isNA } : b));
    } else {
      const { data } = await supabase.from('book_times').insert({ repair_type_id: repairId, device_model_id: modelId, minutes: mins, is_na: isNA }).select().single();
      if (data) setBookTimes(prev => [...prev, data]);
    }
    setSaving(s => ({ ...s, [key]: false }));
    setSaved(s => ({ ...s, [key]: true }));
    setTimeout(() => setSaved(s => ({ ...s, [key]: false })), 1500);
  };

  return (
    <div>
      <div style={{ marginBottom: '1rem', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <label style={labelStyle}>Device type</label>
          <select value={selectedType} onChange={e => setSelectedType(e.target.value)} style={inputStyle}>
            <option value="">— Select device type —</option>
            {deviceTypes.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div style={{ fontSize: '12px', color: '#888', marginTop: '18px' }}>
          Click any cell to edit. Enter minutes or "N/A". Changes save instantly.
        </div>
      </div>

      {selectedType && modelsForType.length > 0 && repairsForType.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '12px', width: '100%' }}>
            <thead>
              <tr style={{ background: NAVY }}>
                <th style={{ ...thStyle, width: '180px' }}>Repair Type</th>
                {modelsForType.map(m => <th key={m.id} style={thStyle}>{m.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {repairsForType.map((repair, ri) => (
                <tr key={repair.id} style={{ background: ri % 2 === 0 ? '#f8fbfd' : '#fff' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 600, fontSize: '12px', color: NAVY, borderBottom: '1px solid #eef3f7' }}>{repair.name}</td>
                  {modelsForType.map(model => {
                    const bt = getBookTime(repair.id, model.id);
                    const key = `${repair.id}_${model.id}`;
                    const val = bt?.is_na ? 'N/A' : (bt?.minutes != null ? String(bt.minutes) : '');
                    return (
                      <td key={model.id} style={{ padding: '4px', borderBottom: '1px solid #eef3f7', textAlign: 'center' }}>
                        <BookCell
                          value={val}
                          onSave={v => updateBookTime(repair.id, model.id, v)}
                          saving={saving[key]}
                          saved={saved[key]}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selectedType && (modelsForType.length === 0 || repairsForType.length === 0) && (
        <div style={{ color: '#888', padding: '2rem', textAlign: 'center' }}>No models or repair types found for this device type.</div>
      )}
    </div>
  );
}

function BookCell({ value, onSave, saving, saved }) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(value);

  useEffect(() => { setLocal(value); }, [value]);

  if (editing) {
    return (
      <input
        autoFocus
        value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={() => { setEditing(false); onSave(local); }}
        onKeyDown={e => { if (e.key === 'Enter') { setEditing(false); onSave(local); } if (e.key === 'Escape') { setEditing(false); setLocal(value); } }}
        style={{ width: '60px', textAlign: 'center', border: `1.5px solid ${BLUE}`, borderRadius: '4px', padding: '3px 4px', fontSize: '12px', outline: 'none' }}
      />
    );
  }

  return (
    <div
      onClick={() => setEditing(true)}
      title="Click to edit"
      style={{
        minWidth: '60px', padding: '4px 8px', textAlign: 'center', cursor: 'pointer',
        borderRadius: '4px', border: `1px solid transparent`,
        background: saved ? '#e6f5ec' : 'transparent',
        color: value === 'N/A' || value === '' ? '#ccc' : NAVY,
        fontWeight: value && value !== 'N/A' ? 600 : 400,
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => e.currentTarget.style.border = `1px solid ${BLUE}`}
      onMouseLeave={e => e.currentTarget.style.border = '1px solid transparent'}
    >
      {saving ? '...' : saved ? '✓' : (value || '—')}
    </div>
  );
}

function DevicesEditor() {
  const [deviceTypes, setDeviceTypes] = useState([]);
  const [deviceModels, setDeviceModels] = useState([]);
  const [repairTypes, setRepairTypes] = useState([]);
  const [selectedType, setSelectedType] = useState('');
  const [newModel, setNewModel] = useState('');
  const [newRepair, setNewRepair] = useState('');
  const [newRepairDiag, setNewRepairDiag] = useState(false);
  const [newRepairLabor, setNewRepairLabor] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const load = async () => {
      const [dt, dm, rt] = await Promise.all([
        supabase.from('device_types').select('*').order('sort_order'),
        supabase.from('device_models').select('*').order('sort_order'),
        supabase.from('repair_types').select('*').order('sort_order'),
      ]);
      setDeviceTypes(dt.data || []);
      setDeviceModels(dm.data || []);
      setRepairTypes(rt.data || []);
    };
    load();
  }, []);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2000); };

  const addModel = async () => {
    if (!newModel.trim() || !selectedType) return;
    const { data } = await supabase.from('device_models').insert({ device_type_id: selectedType, name: newModel.trim(), sort_order: 99 }).select().single();
    if (data) { setDeviceModels(p => [...p, data]); setNewModel(''); flash('Model added!'); }
  };

  const addRepair = async () => {
    if (!newRepair.trim() || !selectedType) return;
    const { data } = await supabase.from('repair_types').insert({ device_type_id: selectedType, name: newRepair.trim(), is_diagnosis: newRepairDiag, is_labor: newRepairLabor, sort_order: 99 }).select().single();
    if (data) { setRepairTypes(p => [...p, data]); setNewRepair(''); flash('Repair type added!'); }
  };

  const toggleActive = async (table, id, current) => {
    await supabase.from(table).update({ active: !current }).eq('id', id);
    const setter = table === 'device_models' ? setDeviceModels : setRepairTypes;
    setter(p => p.map(x => x.id === id ? { ...x, active: !current } : x));
  };

  const modelsForType = deviceModels.filter(m => m.device_type_id === selectedType);
  const repairsForType = repairTypes.filter(r => r.device_type_id === selectedType);

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <label style={labelStyle}>Device type</label>
        <select value={selectedType} onChange={e => setSelectedType(e.target.value)} style={inputStyle}>
          <option value="">— Select device type —</option>
          {deviceTypes.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      {msg && <div style={{ background: '#e6f5ec', color: GREEN, borderRadius: '8px', padding: '8px 14px', fontSize: '13px', marginBottom: '1rem' }}>{msg}</div>}

      {selectedType && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
          {/* Models */}
          <div>
            <div style={{ fontWeight: 700, color: NAVY, marginBottom: '8px', fontSize: '13px' }}>Models</div>
            {modelsForType.map(m => (
              <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: m.active ? '#f8fbfd' : '#fafafa', borderRadius: '6px', marginBottom: '4px', border: '1px solid #eef3f7' }}>
                <span style={{ fontSize: '13px', color: m.active ? NAVY : '#aaa', textDecoration: m.active ? 'none' : 'line-through' }}>{m.name}</span>
                <button onClick={() => toggleActive('device_models', m.id, m.active)} style={{ fontSize: '11px', border: `1px solid ${m.active ? '#f0aaaa' : '#a8dbb8'}`, background: 'transparent', color: m.active ? RED : GREEN, borderRadius: '4px', padding: '2px 8px', cursor: 'pointer' }}>
                  {m.active ? 'Disable' : 'Enable'}
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
              <input value={newModel} onChange={e => setNewModel(e.target.value)} onKeyDown={e => e.key === 'Enter' && addModel()} placeholder="New model name..." style={{ ...inputStyle, flex: 1 }} />
              <button onClick={addModel} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: '8px', padding: '7px 14px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Add</button>
            </div>
          </div>

          {/* Repair types */}
          <div>
            <div style={{ fontWeight: 700, color: NAVY, marginBottom: '8px', fontSize: '13px' }}>Repair Types</div>
            {repairsForType.map(r => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: r.active ? '#f8fbfd' : '#fafafa', borderRadius: '6px', marginBottom: '4px', border: '1px solid #eef3f7' }}>
                <div>
                  <span style={{ fontSize: '13px', color: r.active ? NAVY : '#aaa', textDecoration: r.active ? 'none' : 'line-through' }}>{r.name}</span>
                  {r.is_diagnosis && <span style={{ fontSize: '10px', background: '#e8f6fc', color: BLUE, borderRadius: '4px', padding: '1px 5px', marginLeft: '6px' }}>diag</span>}
                  {r.is_labor && <span style={{ fontSize: '10px', background: '#fff3d0', color: '#9a6000', borderRadius: '4px', padding: '1px 5px', marginLeft: '4px' }}>labor</span>}
                </div>
                <button onClick={() => toggleActive('repair_types', r.id, r.active)} style={{ fontSize: '11px', border: `1px solid ${r.active ? '#f0aaaa' : '#a8dbb8'}`, background: 'transparent', color: r.active ? RED : GREEN, borderRadius: '4px', padding: '2px 8px', cursor: 'pointer' }}>
                  {r.active ? 'Disable' : 'Enable'}
                </button>
              </div>
            ))}
            <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <input value={newRepair} onChange={e => setNewRepair(e.target.value)} onKeyDown={e => e.key === 'Enter' && addRepair()} placeholder="New repair type name..." style={inputStyle} />
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '12px', color: '#555', cursor: 'pointer' }}>
                  <input type="checkbox" checked={newRepairDiag} onChange={e => setNewRepairDiag(e.target.checked)} /> Diagnosis
                </label>
                <label style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '12px', color: '#555', cursor: 'pointer' }}>
                  <input type="checkbox" checked={newRepairLabor} onChange={e => setNewRepairLabor(e.target.checked)} /> Labor x 0.3
                </label>
                <button onClick={addRepair} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: '8px', padding: '7px 14px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', marginLeft: 'auto' }}>Add</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TechniciansEditor() {
  const [technicians, setTechnicians] = useState([]);
  const [newName, setNewName] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newRole, setNewRole] = useState('tech');
  const [editing, setEditing] = useState({});
  const [msg, setMsg] = useState('');

  useEffect(() => {
    supabase.from('technicians').select('*').order('name').then(({ data }) => setTechnicians(data || []));
  }, []);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2000); };

  const addTech = async () => {
    if (!newName.trim() || !newPin.trim()) return;
    const { data } = await supabase.from('technicians').insert({ name: newName.trim(), pin: newPin.trim(), role: newRole }).select().single();
    if (data) { setTechnicians(p => [...p, data]); setNewName(''); setNewPin(''); flash('Technician added!'); }
  };

  const updateTech = async (id, updates) => {
    await supabase.from('technicians').update(updates).eq('id', id);
    setTechnicians(p => p.map(t => t.id === id ? { ...t, ...updates } : t));
    flash('Saved!');
  };

  return (
    <div>
      {msg && <div style={{ background: '#e6f5ec', color: GREEN, borderRadius: '8px', padding: '8px 14px', fontSize: '13px', marginBottom: '1rem' }}>{msg}</div>}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '1.5rem' }}>
        <thead>
          <tr style={{ background: '#f5f5f0' }}>
            {['Name','PIN','Role','Status','Actions'].map(h => <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: '11px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, borderBottom: '1px solid #e0ddd5' }}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {technicians.map(t => (
            <tr key={t.id} style={{ borderBottom: '1px solid #f0ede5' }}>
              <td style={{ padding: '8px 10px', fontWeight: 600, color: NAVY }}>{t.name}</td>
              <td style={{ padding: '8px 10px' }}>
                {editing[t.id] ? (
                  <input defaultValue={t.pin} onBlur={e => updateTech(t.id, { pin: e.target.value })} style={{ ...inputStyle, width: '80px' }} />
                ) : (
                  <span style={{ fontFamily: 'monospace', background: '#f0f0f0', padding: '2px 8px', borderRadius: '4px' }}>{'•'.repeat(t.pin.length)}</span>
                )}
              </td>
              <td style={{ padding: '8px 10px' }}>
                <select value={t.role} onChange={e => updateTech(t.id, { role: e.target.value })} style={{ ...inputStyle, width: '100px' }}>
                  <option value="tech">Tech</option>
                  <option value="admin">Admin</option>
                </select>
              </td>
              <td style={{ padding: '8px 10px' }}>
                <span style={{ background: t.active ? '#e6f5ec' : '#fce8e8', color: t.active ? GREEN : RED, borderRadius: '20px', padding: '2px 10px', fontSize: '11px', fontWeight: 700 }}>
                  {t.active ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td style={{ padding: '8px 10px', display: 'flex', gap: '6px' }}>
                <button onClick={() => setEditing(p => ({ ...p, [t.id]: !p[t.id] }))} style={{ fontSize: '11px', border: `1px solid ${BLUE}`, background: 'transparent', color: BLUE, borderRadius: '4px', padding: '2px 8px', cursor: 'pointer' }}>
                  {editing[t.id] ? 'Done' : 'Change PIN'}
                </button>
                <button onClick={() => updateTech(t.id, { active: !t.active })} style={{ fontSize: '11px', border: `1px solid ${t.active ? '#f0aaaa' : '#a8dbb8'}`, background: 'transparent', color: t.active ? RED : GREEN, borderRadius: '4px', padding: '2px 8px', cursor: 'pointer' }}>
                  {t.active ? 'Disable' : 'Enable'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ background: '#f8fbfd', borderRadius: '10px', padding: '1rem', border: `1px solid ${BORDER}` }}>
        <div style={{ fontWeight: 700, color: NAVY, marginBottom: '12px', fontSize: '13px' }}>Add Technician</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><label style={labelStyle}>Name</label><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Full name" style={inputStyle} /></div>
          <div><label style={labelStyle}>PIN</label><input value={newPin} onChange={e => setNewPin(e.target.value)} placeholder="e.g. 1234" maxLength={6} style={{ ...inputStyle, width: '100px' }} /></div>
          <div><label style={labelStyle}>Role</label>
            <select value={newRole} onChange={e => setNewRole(e.target.value)} style={inputStyle}>
              <option value="tech">Tech</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button onClick={addTech} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Add</button>
        </div>
      </div>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: '11px', fontWeight: 600, color: '#555', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' };
const inputStyle = { border: '1.5px solid #d0cdc5', borderRadius: '8px', padding: '7px 10px', fontSize: '13px', outline: 'none', fontFamily: 'inherit', color: '#1a2a3a', background: '#fff' };
const thStyle = { padding: '8px 10px', textAlign: 'center', fontSize: '11px', color: '#7aafc8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, borderBottom: '2px solid #1B9BD4', whiteSpace: 'nowrap', minWidth: '80px' };
