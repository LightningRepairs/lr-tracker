import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { clearSettingsCache } from '../lib/settings';

const BLUE = '#1B9BD4';
const NAVY = '#1a2a3a';
const BORDER = '#b8dff0';
const GREEN = '#2d8a4e';
const RED = '#b52020';
const YELLOW = '#F5C518';

export default function AdminPanel() {
  const [tab, setTab] = useState('booktimes');
  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ background: '#fff', borderRadius: '12px', border: `1.5px solid ${BORDER}`, overflow: 'hidden' }}>
        <div style={{ background: NAVY, padding: '1rem 1.5rem', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ color: '#fff', fontWeight: 700, fontSize: '15px', marginRight: '16px' }}>Admin Panel</span>
          {[['booktimes','Book Times'],['devices','Devices & Repairs'],['technicians','Technicians'],['settings','Settings']].map(([key, label]) => (
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
          {tab === 'settings' && <SettingsEditor />}
        </div>
      </div>
    </div>
  );
}

// ── BOOK TIMES ──────────────────────────────────────────────
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

  const getBookTime = (repairId, modelId) =>
    bookTimes.find(b => b.repair_type_id === repairId && b.device_model_id === modelId);

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
          Click any cell to edit. Enter minutes or "N/A". Saves instantly.
        </div>
      </div>
      {selectedType && modelsForType.length > 0 && repairsForType.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '12px', width: '100%' }}>
            <thead>
              <tr style={{ background: NAVY }}>
                <th style={{ ...thStyle, width: '180px', textAlign: 'left' }}>Repair Type</th>
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
                        <BookCell value={val} onSave={v => updateBookTime(repair.id, model.id, v)} saving={saving[key]} saved={saved[key]} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <input autoFocus value={local} onChange={e => setLocal(e.target.value)}
        onBlur={() => { setEditing(false); onSave(local); }}
        onKeyDown={e => { if (e.key === 'Enter') { setEditing(false); onSave(local); } if (e.key === 'Escape') { setEditing(false); setLocal(value); } }}
        style={{ width: '60px', textAlign: 'center', border: `1.5px solid ${BLUE}`, borderRadius: '4px', padding: '3px 4px', fontSize: '12px', outline: 'none' }}
      />
    );
  }
  return (
    <div onClick={() => setEditing(true)} title="Click to edit"
      style={{ minWidth: '60px', padding: '4px 8px', textAlign: 'center', cursor: 'pointer', borderRadius: '4px', border: '1px solid transparent', background: saved ? '#e6f5ec' : 'transparent', color: !value || value === 'N/A' ? '#ccc' : NAVY, fontWeight: value && value !== 'N/A' ? 600 : 400 }}
      onMouseEnter={e => e.currentTarget.style.border = `1px solid ${BLUE}`}
      onMouseLeave={e => e.currentTarget.style.border = '1px solid transparent'}
    >
      {saving ? '...' : saved ? '✓' : (value || '—')}
    </div>
  );
}

// ── DEVICES & REPAIRS ────────────────────────────────────────
function DevicesEditor() {
  const [deviceTypes, setDeviceTypes] = useState([]);
  const [deviceModels, setDeviceModels] = useState([]);
  const [repairTypes, setRepairTypes] = useState([]);
  const [selectedType, setSelectedType] = useState('');
  const [newModel, setNewModel] = useState('');
  const [newRepair, setNewRepair] = useState('');
  const [newRepairDiag, setNewRepairDiag] = useState(false);
  const [newRepairLabor, setNewRepairLabor] = useState(false);
  const [newRepairMultiplier, setNewRepairMultiplier] = useState('0.3');
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

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };

  const modelsForType = deviceModels.filter(m => m.device_type_id === selectedType);
  const repairsForType = repairTypes.filter(r => r.device_type_id === selectedType);

  // Move item up/down in sort order
  const moveItem = async (list, item, dir, table, setList) => {
    const sorted = [...list].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex(x => x.id === item.id);
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    const aOrd = item.sort_order;
    const bOrd = other.sort_order;
    await Promise.all([
      supabase.from(table).update({ sort_order: bOrd }).eq('id', item.id),
      supabase.from(table).update({ sort_order: aOrd }).eq('id', other.id),
    ]);
    setList(prev => prev.map(x => {
      if (x.id === item.id) return { ...x, sort_order: bOrd };
      if (x.id === other.id) return { ...x, sort_order: aOrd };
      return x;
    }));
  };

  const moveDeviceType = (item, dir) => moveItem(deviceTypes, item, dir, 'device_types', setDeviceTypes);
  const moveModel = (item, dir) => moveItem(modelsForType, item, dir, 'device_models', setDeviceModels);
  const moveRepair = (item, dir) => moveItem(repairsForType, item, dir, 'repair_types', setRepairTypes);

  // Inline name editing
  const updateName = async (table, id, name, setList) => {
    await supabase.from(table).update({ name }).eq('id', id);
    setList(prev => prev.map(x => x.id === id ? { ...x, name } : x));
    flash('Name updated!');
  };

  const addModel = async () => {
    if (!newModel.trim() || !selectedType) return;
    const maxOrd = Math.max(0, ...modelsForType.map(m => m.sort_order));
    const { data } = await supabase.from('device_models').insert({ device_type_id: selectedType, name: newModel.trim(), sort_order: maxOrd + 1 }).select().single();
    if (data) { setDeviceModels(p => [...p, data]); setNewModel(''); flash('Model added!'); }
  };

  const addRepair = async () => {
    if (!newRepair.trim() || !selectedType) return;
    const maxOrd = Math.max(0, ...repairsForType.map(r => r.sort_order));
    const multiplier = newRepairLabor ? parseFloat(newRepairMultiplier) || 0.3 : null;
    const repairName = newRepairLabor ? `${newRepair.trim()} (Labor x ${multiplier})` : newRepair.trim();
    const { data } = await supabase.from('repair_types').insert({
      device_type_id: selectedType, name: repairName,
      is_diagnosis: newRepairDiag, is_labor: newRepairLabor,
      labor_multiplier: multiplier, sort_order: maxOrd + 1,
    }).select().single();
    if (data) { setRepairTypes(p => [...p, data]); setNewRepair(''); flash('Repair type added!'); }
  };

  const toggleActive = async (table, id, current, setList) => {
    await supabase.from(table).update({ active: !current }).eq('id', id);
    setList(prev => prev.map(x => x.id === id ? { ...x, active: !current } : x));
  };

  const sortedDeviceTypes = [...deviceTypes].sort((a, b) => a.sort_order - b.sort_order);
  const sortedModels = [...modelsForType].sort((a, b) => a.sort_order - b.sort_order);
  const sortedRepairs = [...repairsForType].sort((a, b) => a.sort_order - b.sort_order);

  return (
    <div>
      {msg && <div style={{ background: '#e6f5ec', color: GREEN, borderRadius: '8px', padding: '8px 14px', fontSize: '13px', marginBottom: '1rem' }}>{msg}</div>}

      {/* Device Types reorder */}
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ fontWeight: 700, color: NAVY, marginBottom: '8px', fontSize: '13px' }}>Device Type Order</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {sortedDeviceTypes.map((dt, idx) => (
            <div key={dt.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#f8fbfd', border: '1px solid #eef3f7', borderRadius: '6px', padding: '4px 8px' }}>
              <span style={{ fontSize: '12px', color: NAVY, fontWeight: 600 }}>{dt.name}</span>
              <button onClick={() => moveDeviceType(dt, -1)} disabled={idx === 0} style={arrowBtn}>↑</button>
              <button onClick={() => moveDeviceType(dt, 1)} disabled={idx === sortedDeviceTypes.length - 1} style={arrowBtn}>↓</button>
            </div>
          ))}
        </div>
      </div>

      {/* Select device type */}
      <div style={{ marginBottom: '1rem' }}>
        <label style={labelStyle}>Edit models & repairs for</label>
        <select value={selectedType} onChange={e => setSelectedType(e.target.value)} style={inputStyle}>
          <option value="">— Select device type —</option>
          {sortedDeviceTypes.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      {selectedType && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
          {/* Models */}
          <div>
            <div style={{ fontWeight: 700, color: NAVY, marginBottom: '8px', fontSize: '13px' }}>Models</div>
            {sortedModels.map((m, idx) => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', background: m.active ? '#f8fbfd' : '#fafafa', borderRadius: '6px', marginBottom: '4px', border: '1px solid #eef3f7' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                  <button onClick={() => moveModel(m, -1)} disabled={idx === 0} style={arrowBtn}>↑</button>
                  <button onClick={() => moveModel(m, 1)} disabled={idx === sortedModels.length - 1} style={arrowBtn}>↓</button>
                </div>
                <InlineEdit value={m.name} onSave={v => updateName('device_models', m.id, v, setDeviceModels)} active={m.active} />
                <button onClick={() => toggleActive('device_models', m.id, m.active, setDeviceModels)}
                  style={{ fontSize: '10px', border: `1px solid ${m.active ? '#f0aaaa' : '#a8dbb8'}`, background: 'transparent', color: m.active ? RED : GREEN, borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {m.active ? 'Disable' : 'Enable'}
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
              <input value={newModel} onChange={e => setNewModel(e.target.value)} onKeyDown={e => e.key === 'Enter' && addModel()} placeholder="New model name..." style={{ ...inputStyle, flex: 1 }} />
              <button onClick={addModel} style={addBtn}>Add</button>
            </div>
          </div>

          {/* Repair types */}
          <div>
            <div style={{ fontWeight: 700, color: NAVY, marginBottom: '8px', fontSize: '13px' }}>Repair Types</div>
            {sortedRepairs.map((r, idx) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', background: r.active ? '#f8fbfd' : '#fafafa', borderRadius: '6px', marginBottom: '4px', border: '1px solid #eef3f7' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                  <button onClick={() => moveRepair(r, -1)} disabled={idx === 0} style={arrowBtn}>↑</button>
                  <button onClick={() => moveRepair(r, 1)} disabled={idx === sortedRepairs.length - 1} style={arrowBtn}>↓</button>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <InlineEdit value={r.name} onSave={v => updateName('repair_types', r.id, v, setRepairTypes)} active={r.active} />
                  <div style={{ display: 'flex', gap: '4px', marginTop: '2px' }}>
                    {r.is_diagnosis && <span style={{ fontSize: '9px', background: '#e8f6fc', color: BLUE, borderRadius: '4px', padding: '1px 4px' }}>diag</span>}
                    {r.is_labor && <span style={{ fontSize: '9px', background: '#fff3d0', color: '#9a6000', borderRadius: '4px', padding: '1px 4px' }}>labor x {r.labor_multiplier || 0.3}</span>}
                  </div>
                </div>
                <button onClick={() => toggleActive('repair_types', r.id, r.active, setRepairTypes)}
                  style={{ fontSize: '10px', border: `1px solid ${r.active ? '#f0aaaa' : '#a8dbb8'}`, background: 'transparent', color: r.active ? RED : GREEN, borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {r.active ? 'Disable' : 'Enable'}
                </button>
              </div>
            ))}
            {/* Add repair form */}
            <div style={{ marginTop: '10px', background: '#f8fbfd', borderRadius: '8px', padding: '10px', border: '1px solid #eef3f7' }}>
              <input value={newRepair} onChange={e => setNewRepair(e.target.value)} placeholder="Repair type name..." style={{ ...inputStyle, width: '100%', marginBottom: '8px' }} />
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
                <label style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '12px', color: '#555', cursor: 'pointer' }}>
                  <input type="checkbox" checked={newRepairDiag} onChange={e => setNewRepairDiag(e.target.checked)} /> Diagnosis
                </label>
                <label style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '12px', color: '#555', cursor: 'pointer' }}>
                  <input type="checkbox" checked={newRepairLabor} onChange={e => setNewRepairLabor(e.target.checked)} /> Labor
                </label>
                {newRepairLabor && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ fontSize: '12px', color: '#555' }}>Multiplier:</span>
                    <input type="number" step="0.01" min="0.01" value={newRepairMultiplier}
                      onChange={e => setNewRepairMultiplier(e.target.value)}
                      style={{ ...inputStyle, width: '70px' }} />
                    <span style={{ fontSize: '11px', color: '#888' }}>(e.g. 0.3)</span>
                  </div>
                )}
              </div>
              <button onClick={addRepair} style={{ ...addBtn, width: '100%' }}>Add repair type</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InlineEdit({ value, onSave, active }) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  if (editing) {
    return (
      <input autoFocus value={local} onChange={e => setLocal(e.target.value)}
        onBlur={() => { setEditing(false); if (local.trim() && local !== value) onSave(local.trim()); }}
        onKeyDown={e => { if (e.key === 'Enter') { setEditing(false); if (local.trim() && local !== value) onSave(local.trim()); } if (e.key === 'Escape') { setEditing(false); setLocal(value); } }}
        style={{ flex: 1, border: `1.5px solid ${BLUE}`, borderRadius: '4px', padding: '2px 6px', fontSize: '12px', outline: 'none', minWidth: 0 }}
      />
    );
  }
  return (
    <span onClick={() => setEditing(true)} title="Click to rename"
      style={{ flex: 1, fontSize: '12px', color: active ? NAVY : '#aaa', textDecoration: active ? 'none' : 'line-through', cursor: 'text', padding: '2px 4px', borderRadius: '4px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      onMouseEnter={e => e.currentTarget.style.background = '#e8f6fc'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >{local}</span>
  );
}

// ── TECHNICIANS ──────────────────────────────────────────────
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

  const roleLabel = (role) => {
    if (role === 'admin') return { label: 'Admin', bg: '#fce8e8', color: RED };
    if (role === 'manager') return { label: 'Manager', bg: '#fff3d0', color: '#9a6000' };
    return { label: 'Tech', bg: '#e8f6fc', color: BLUE };
  };

  return (
    <div>
      {msg && <div style={{ background: '#e6f5ec', color: GREEN, borderRadius: '8px', padding: '8px 14px', fontSize: '13px', marginBottom: '1rem' }}>{msg}</div>}
      <div style={{ fontSize: '12px', color: '#888', marginBottom: '1rem', background: '#f8fbfd', borderRadius: '8px', padding: '10px 14px', border: '1px solid #eef3f7' }}>
        <strong>Roles:</strong> &nbsp;
        <span style={{ color: BLUE, fontWeight: 600 }}>Tech</span> — daily sheet only &nbsp;|&nbsp;
        <span style={{ color: '#9a6000', fontWeight: 600 }}>Manager</span> — daily sheet + manager view &nbsp;|&nbsp;
        <span style={{ color: RED, fontWeight: 600 }}>Admin</span> — full access including book times &amp; settings
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '1.5rem' }}>
        <thead>
          <tr style={{ background: '#f5f5f0' }}>
            {['Name','PIN','Role','Status','Actions'].map(h => (
              <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: '11px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, borderBottom: '1px solid #e0ddd5' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {technicians.map(t => {
            const rl = roleLabel(t.role);
            return (
              <tr key={t.id} style={{ borderBottom: '1px solid #f0ede5' }}>
                <td style={{ padding: '8px 10px', fontWeight: 600, color: NAVY }}>{t.name}</td>
                <td style={{ padding: '8px 10px' }}>
                  {editing[t.id] ? (
                    <input defaultValue={t.pin} onBlur={e => { updateTech(t.id, { pin: e.target.value }); setEditing(p => ({ ...p, [t.id]: false })); }} style={{ ...inputStyle, width: '80px' }} autoFocus />
                  ) : (
                    <span style={{ fontFamily: 'monospace', background: '#f0f0f0', padding: '2px 8px', borderRadius: '4px' }}>{'•'.repeat(t.pin?.length || 4)}</span>
                  )}
                </td>
                <td style={{ padding: '8px 10px' }}>
                  <select value={t.role} onChange={e => updateTech(t.id, { role: e.target.value })} style={{ ...inputStyle, width: '110px' }}>
                    <option value="tech">Tech</option>
                    <option value="manager">Manager</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td style={{ padding: '8px 10px' }}>
                  <span style={{ background: t.active ? '#e6f5ec' : '#fce8e8', color: t.active ? GREEN : RED, borderRadius: '20px', padding: '2px 10px', fontSize: '11px', fontWeight: 700 }}>
                    {t.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td style={{ padding: '8px 10px', display: 'flex', gap: '6px' }}>
                  <button onClick={() => setEditing(p => ({ ...p, [t.id]: !p[t.id] }))}
                    style={{ fontSize: '11px', border: `1px solid ${BLUE}`, background: 'transparent', color: BLUE, borderRadius: '4px', padding: '2px 8px', cursor: 'pointer' }}>
                    {editing[t.id] ? 'Done' : 'Change PIN'}
                  </button>
                  <button onClick={() => updateTech(t.id, { active: !t.active })}
                    style={{ fontSize: '11px', border: `1px solid ${t.active ? '#f0aaaa' : '#a8dbb8'}`, background: 'transparent', color: t.active ? RED : GREEN, borderRadius: '4px', padding: '2px 8px', cursor: 'pointer' }}>
                    {t.active ? 'Disable' : 'Enable'}
                  </button>
                </td>
              </tr>
            );
          })}
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
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button onClick={addTech} style={addBtn}>Add</button>
        </div>
      </div>
    </div>
  );
}

// ── SETTINGS ─────────────────────────────────────────────────
function SettingsEditor() {
  const [settings, setSettings] = useState([]);
  const [saving, setSaving] = useState({});
  const [saved, setSaved] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.from('settings').select('*').order('key').then(({ data }) => {
      setSettings(data || []);
      setLoading(false);
    });
  }, []);

  const updateSetting = async (key, value) => {
    setSaving(s => ({ ...s, [key]: true }));
    await supabase.from('settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key);
    setSettings(prev => prev.map(s => s.key === key ? { ...s, value } : s));
    clearSettingsCache();
    setSaving(s => ({ ...s, [key]: false }));
    setSaved(s => ({ ...s, [key]: true }));
    setTimeout(() => setSaved(s => ({ ...s, [key]: false })), 1500);
  };

  const GROUPS = [
    {
      title: 'Efficiency Thresholds',
      desc: 'Controls the green/yellow/red color coding on the tracker and manager view.',
      keys: ['efficiency_green', 'efficiency_yellow'],
    },
    {
      title: 'Sheet Defaults',
      desc: 'Default values used when a tech opens a fresh daily sheet.',
      keys: ['default_rows', 'default_labor_multiplier'],
    },
    {
      title: 'General',
      desc: 'General app settings.',
      keys: ['shop_name'],
    },
  ];

  if (loading) return <div style={{ color: '#888', padding: '2rem', textAlign: 'center' }}>Loading...</div>;

  return (
    <div>
      <div style={{ fontSize: '12px', color: '#888', marginBottom: '1.5rem', background: '#f8fbfd', borderRadius: '8px', padding: '10px 14px', border: '1px solid #eef3f7' }}>
        Changes take effect immediately for all users. No redeploy needed.
      </div>

      {/* Efficiency preview */}
      <div style={{ marginBottom: '1.5rem', background: '#f8fbfd', borderRadius: '10px', padding: '1rem', border: '1px solid #eef3f7' }}>
        <div style={{ fontWeight: 700, color: '#1a2a3a', marginBottom: '8px', fontSize: '13px' }}>Color preview</div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          {(() => {
            const green = parseInt(settings.find(s => s.key === 'efficiency_green')?.value || 90);
            const yellow = parseInt(settings.find(s => s.key === 'efficiency_yellow')?.value || 79);
            return <>
              <span style={{ background: '#e6f5ec', color: '#2d8a4e', fontWeight: 700, padding: '4px 12px', borderRadius: '20px', fontSize: '12px' }}>{green}–100%+ Green</span>
              <span style={{ background: '#fff3d0', color: '#9a6000', fontWeight: 700, padding: '4px 12px', borderRadius: '20px', fontSize: '12px' }}>{yellow}–{green - 1}% Yellow</span>
              <span style={{ background: '#fce8e8', color: '#b52020', fontWeight: 700, padding: '4px 12px', borderRadius: '20px', fontSize: '12px' }}>0–{yellow - 1}% Red</span>
            </>;
          })()}
        </div>
      </div>

      {GROUPS.map(group => (
        <div key={group.title} style={{ marginBottom: '1.5rem' }}>
          <div style={{ fontWeight: 700, color: '#1a2a3a', fontSize: '14px', marginBottom: '4px' }}>{group.title}</div>
          <div style={{ fontSize: '12px', color: '#888', marginBottom: '10px' }}>{group.desc}</div>
          {group.keys.map(key => {
            const s = settings.find(x => x.key === key);
            if (!s) return null;
            return (
              <SettingRow key={key} setting={s} onSave={v => updateSetting(key, v)} saving={saving[key]} saved={saved[key]} />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SettingRow({ setting, onSave, saving, saved }) {
  const [local, setLocal] = useState(setting.value);
  useEffect(() => { setLocal(setting.value); }, [setting.value]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '10px 14px', background: '#fff', borderRadius: '8px', border: '1px solid #eef3f7', marginBottom: '6px' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: '13px', color: '#1a2a3a' }}>{setting.label}</div>
        <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>{setting.description}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <input
          value={local}
          onChange={e => setLocal(e.target.value)}
          onBlur={() => { if (local !== setting.value) onSave(local); }}
          onKeyDown={e => { if (e.key === 'Enter') onSave(local); }}
          style={{ border: '1.5px solid #d0cdc5', borderRadius: '8px', padding: '6px 10px', fontSize: '13px', outline: 'none', fontFamily: 'inherit', color: '#1a2a3a', width: '140px', textAlign: 'right' }}
        />
        {saving && <span style={{ fontSize: '12px', color: '#888' }}>Saving...</span>}
        {saved && <span style={{ fontSize: '12px', color: '#2d8a4e', fontWeight: 700 }}>✓ Saved</span>}
      </div>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: '11px', fontWeight: 600, color: '#555', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' };
const inputStyle = { border: '1.5px solid #d0cdc5', borderRadius: '8px', padding: '7px 10px', fontSize: '13px', outline: 'none', fontFamily: 'inherit', color: '#1a2a3a', background: '#fff' };
const thStyle = { padding: '8px 10px', textAlign: 'center', fontSize: '11px', color: '#7aafc8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, borderBottom: '2px solid #1B9BD4', whiteSpace: 'nowrap', minWidth: '80px' };
const arrowBtn = { background: 'transparent', border: '1px solid #d0cdc5', borderRadius: '3px', padding: '1px 4px', fontSize: '10px', cursor: 'pointer', color: '#666', lineHeight: 1 };
const addBtn = { background: '#1B9BD4', color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 16px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
