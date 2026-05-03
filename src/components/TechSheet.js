import React, { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';

const BLUE = '#1B9BD4';
const NAVY = '#1a2a3a';
const YELLOW = '#F5C518';
const BLUE_LIGHT = '#e8f6fc';
const BLUE_MID = '#cceaf7';
const BORDER = '#b8dff0';
const GREEN = '#2d8a4e';
const GREEN_BG = '#e6f5ec';
const AMBER = '#9a6000';
const AMBER_BG = '#fff3d0';
const RED = '#b52020';
const RED_BG = '#fce8e8';

function pad(n) { return String(n).padStart(2, '0'); }
function fmtTimer(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${pad(m)}:${pad(s)}:${pad(cs)}`;
}
function effColor(pct) {
  if (pct === null) return '#aac8d8';
  return pct >= 90 ? GREEN : pct >= 65 ? AMBER : RED;
}
function rowBg(pct) {
  if (pct === null) return 'transparent';
  return pct >= 90 ? GREEN_BG : pct >= 65 ? AMBER_BG : RED_BG;
}

const EMPTY_ROW = () => ({
  _id: Math.random().toString(36).slice(2),
  dbId: null,
  ticketNumber: '',
  deviceTypeId: '',
  deviceModelId: '',
  repairTypeId: '',
  actualMinutes: '',
  laborCost: '',
  isFullSet: false,
  notes: '',
  timerMs: 0,
  timerState: 'idle',
  timerStart: null,
});

export default function TechSheet({ tech }) {
  const [rows, setRows] = useState(() => Array.from({ length: 10 }, EMPTY_ROW));
  const [deviceTypes, setDeviceTypes] = useState([]);
  const [deviceModels, setDeviceModels] = useState([]);
  const [repairTypes, setRepairTypes] = useState([]);
  const [bookTimes, setBookTimes] = useState([]);
  const [loading, setLoading] = useState(true);
  const timerRefs = useRef({});
  const today = new Date().toISOString().slice(0, 10);

  // Load reference data
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
      setLoading(false);
    };
    load();
  }, []);

  // Load today's tickets for this tech
  useEffect(() => {
    if (!tech) return;
    supabase.from('tickets')
      .select('*')
      .eq('technician_id', tech.id)
      .eq('work_date', today)
      .order('created_at')
      .then(({ data }) => {
        if (data && data.length > 0) {
          const loaded = data.map(t => ({
            _id: t.id,
            dbId: t.id,
            ticketNumber: t.ticket_number || '',
            deviceTypeId: t.device_type_id || '',
            deviceModelId: t.device_model_id || '',
            repairTypeId: t.repair_type_id || '',
            actualMinutes: t.actual_minutes != null ? String(t.actual_minutes) : '',
            laborCost: t.labor_cost != null ? String(t.labor_cost) : '',
            isFullSet: t.is_full_set || false,
            notes: t.notes || '',
            timerMs: 0, timerState: 'idle', timerStart: null,
          }));
          const blanks = Math.max(0, 10 - loaded.length);
          setRows([...loaded, ...Array.from({ length: blanks }, EMPTY_ROW)]);
        }
      });
  }, [tech, today]);

  const getBookMinutes = useCallback((repairTypeId, deviceModelId, isFullSet) => {
    const rt = repairTypes.find(r => r.id === repairTypeId);
    if (!rt) return null;
    if (rt.is_labor) return null; // handled separately
    const bt = bookTimes.find(b => b.repair_type_id === repairTypeId && b.device_model_id === deviceModelId);
    if (!bt || bt.is_na) return null;
    return bt.minutes;
  }, [repairTypes, bookTimes]);

  const getLaborBookMinutes = useCallback((repairTypeId, laborCost) => {
    const rt = repairTypes.find(r => r.id === repairTypeId);
    if (!rt?.is_labor) return null;
    const cost = parseFloat(laborCost) || 0;
    const multiplier = parseFloat(rt.labor_multiplier) || 0.3;
    return cost > 0 ? Math.round(cost * multiplier) : null;
  }, [repairTypes]);

  const calcEfficiency = useCallback((row) => {
    const actual = parseFloat(row.actualMinutes) || 0;
    if (actual <= 0) return null;
    const rt = repairTypes.find(r => r.id === row.repairTypeId);
    const book = rt?.is_labor
      ? getLaborBookMinutes(row.repairTypeId, row.laborCost)
      : getBookMinutes(row.repairTypeId, row.deviceModelId, row.isFullSet);
    if (book === null || book === undefined) return null;
    return Math.round((book / actual) * 100);
  }, [repairTypes, getBookMinutes, getLaborBookMinutes]);

  const saveRow = useCallback(async (row) => {
    if (!row.ticketNumber && !row.repairTypeId) return;
    const rt = repairTypes.find(r => r.id === row.repairTypeId);
    const book = rt?.is_labor
      ? getLaborBookMinutes(row.repairTypeId, row.laborCost)
      : getBookMinutes(row.repairTypeId, row.deviceModelId, row.isFullSet);
    const actual = parseFloat(row.actualMinutes) || null;
    const pct = actual && book ? Math.round((book / actual) * 100) : null;

    const payload = {
      technician_id: tech.id,
      ticket_number: row.ticketNumber || null,
      device_type_id: row.deviceTypeId || null,
      device_model_id: row.deviceModelId || null,
      repair_type_id: row.repairTypeId || null,
      book_minutes: book,
      actual_minutes: actual,
      labor_cost: parseFloat(row.laborCost) || null,
      is_full_set: row.isFullSet,
      notes: row.notes || null,
      efficiency_pct: pct,
      work_date: today,
    };

    if (row.dbId) {
      await supabase.from('tickets').update(payload).eq('id', row.dbId);
    } else {
      const { data } = await supabase.from('tickets').insert(payload).select().single();
      if (data) {
        setRows(prev => prev.map(r => r._id === row._id ? { ...r, dbId: data.id } : r));
      }
    }
  }, [tech, today, repairTypes, getBookMinutes, getLaborBookMinutes]);

  const updateRow = useCallback((id, updates) => {
    setRows(prev => prev.map(r => {
      if (r._id !== id) return r;
      const updated = { ...r, ...updates };
      // debounce save
      clearTimeout(timerRefs.current['save_' + id]);
      timerRefs.current['save_' + id] = setTimeout(() => saveRow(updated), 800);
      return updated;
    }));
  }, [saveRow]);

  // TIMER
  const timerStart = (id) => {
    setRows(prev => prev.map(r => {
      if (r._id !== id || r.timerState === 'running') return r;
      const startMs = Date.now() - r.timerMs;
      clearInterval(timerRefs.current['timer_' + id]);
      timerRefs.current['timer_' + id] = setInterval(() => {
        setRows(p => p.map(rr => rr._id === id && rr.timerState === 'running'
          ? { ...rr, timerMs: Date.now() - startMs } : rr));
      }, 50);
      return { ...r, timerState: 'running', timerStart: startMs };
    }));
  };

  const timerPause = (id) => {
    clearInterval(timerRefs.current['timer_' + id]);
    setRows(prev => prev.map(r => r._id === id ? { ...r, timerState: 'paused' } : r));
  };

  const timerStop = (id) => {
    clearInterval(timerRefs.current['timer_' + id]);
    setRows(prev => prev.map(r => {
      if (r._id !== id) return r;
      const mins = r.timerMs > 0 ? Math.max(1, Math.round(r.timerMs / 60000)) : 0;
      const updated = { ...r, timerState: 'idle', timerMs: 0, timerStart: null,
        actualMinutes: mins > 0 ? String(mins) : r.actualMinutes };
      clearTimeout(timerRefs.current['save_' + id]);
      timerRefs.current['save_' + id] = setTimeout(() => saveRow(updated), 800);
      return updated;
    }));
  };

  const addRow = () => setRows(prev => [...prev, EMPTY_ROW()]);

  const clearAll = () => {
    if (!window.confirm('Clear all rows for today? This will delete saved data.')) return;
    Object.values(timerRefs.current).forEach(clearInterval);
    supabase.from('tickets').delete().eq('technician_id', tech.id).eq('work_date', today);
    setRows(Array.from({ length: 10 }, EMPTY_ROW));
  };

  // Stats
  const filledRows = rows.filter(r => r.ticketNumber);
  const repaired = filledRows.filter(r => {
    const rt = repairTypes.find(x => x.id === r.repairTypeId);
    return rt && !rt.is_diagnosis;
  });
  const diagnosed = filledRows.filter(r => {
    const rt = repairTypes.find(x => x.id === r.repairTypeId);
    return rt?.is_diagnosis;
  });
  const timedRows = rows.filter(r => {
    const actual = parseFloat(r.actualMinutes) || 0;
    return actual > 0 && calcEfficiency(r) !== null;
  });
  const totalActual = timedRows.reduce((s, r) => s + (parseFloat(r.actualMinutes) || 0), 0);
  const totalBook = timedRows.reduce((s, r) => {
    const rt = repairTypes.find(x => x.id === r.repairTypeId);
    return s + (rt?.is_labor
      ? (getLaborBookMinutes(r.repairTypeId, r.laborCost) || 0)
      : (getBookMinutes(r.repairTypeId, r.deviceModelId, r.isFullSet) || 0));
  }, 0);
  const avgEff = timedRows.length > 0 ? Math.round((totalBook / totalActual) * 100) : null;

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  if (loading) return <div style={{ color: '#fff', textAlign: 'center', padding: '3rem' }}>Loading...</div>;

  return (
    <div style={{ maxWidth: '1300px', margin: '0 auto' }}>
      {/* Header card */}
      <div style={{ background: BLUE, borderRadius: '12px 12px 0 0', padding: '0.85rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: '13px' }}>{tech.name}</div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Daily Ticket Tracker</div>
          <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: '11px', marginTop: '2px' }}>{dateStr}</div>
        </div>
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>Auto-saves</div>
      </div>

      {/* Stats bar */}
      <div style={{ background: BLUE, padding: '0 1.5rem 0.85rem' }}>
        {/* Avg efficiency pill */}
        <div style={{ textAlign: 'center', marginBottom: '8px' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', background: NAVY, border: '1px solid rgba(255,255,255,0.15)', borderRadius: '10px', padding: '6px 20px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Avg Efficiency</span>
            <span style={{ fontSize: '20px', fontWeight: 800, color: avgEff === null ? YELLOW : effColor(avgEff) }}>
              {avgEff === null ? '—' : `${avgEff}%`}
            </span>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '10px' }}>
          {[
            ['Total Repaired', repaired.length],
            ['Total Diagnosed', diagnosed.length],
            ['Total Tickets', filledRows.length],
            ['Book Time', totalBook > 0 ? `${totalBook}m` : '—'],
            ['Actual Time', totalActual > 0 ? `${totalActual}m` : '—'],
          ].map(([label, val]) => (
            <div key={label} style={{ background: NAVY, borderRadius: '8px', padding: '0.65rem 0.85rem', border: '1px solid rgba(255,255,255,0.1)' }}>
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.85)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, marginBottom: '3px' }}>{label}</div>
              <div style={{ fontSize: '19px', fontWeight: 700, color: '#fff' }}>{val}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={{ background: '#fff', borderRadius: '0 0 12px 12px', border: `1.5px solid ${BORDER}`, borderTop: 'none', overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: '1100px' }}>
            <thead>
              <tr style={{ background: NAVY }}>
                {['Ticket #','Device Type','Model','Repair Type','Book','Actual (min)','+/− min','Efficiency','Timer','Notes'].map(h => (
                  <th key={h} style={{ padding: '8px 6px', textAlign: 'left', fontWeight: 700, fontSize: '10px', color: '#7aafc8', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: `2px solid ${BLUE}`, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <TicketRow
                  key={row._id}
                  row={row}
                  idx={idx}
                  deviceTypes={deviceTypes}
                  deviceModels={deviceModels}
                  repairTypes={repairTypes}
                  bookTimes={bookTimes}
                  getBookMinutes={getBookMinutes}
                  getLaborBookMinutes={getLaborBookMinutes}
                  calcEfficiency={calcEfficiency}
                  updateRow={updateRow}
                  timerStart={timerStart}
                  timerPause={timerPause}
                  timerStop={timerStop}
                />
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', borderTop: `1px solid ${BORDER}`, flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn onClick={addRow}>+ Add row</Btn>
            <Btn danger onClick={clearAll}>Clear all</Btn>
          </div>
          <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
            {[['dot-good', GREEN, '≥90% On pace'], ['dot-warn', AMBER, '65–89% Moderate'], ['dot-bad', RED, '<65% Over book']].map(([k, c, l]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: '#666' }}>
                <div style={{ width: 9, height: 9, borderRadius: '50%', background: c }} />{l}
              </div>
            ))}
          </div>
          <Btn primary onClick={() => window.print()}>⬇ Download PDF</Btn>
        </div>
      </div>
    </div>
  );
}

function TicketRow({ row, idx, deviceTypes, deviceModels, repairTypes, bookTimes, getBookMinutes, getLaborBookMinutes, calcEfficiency, updateRow, timerStart, timerPause, timerStop }) {
  const modelsForType = deviceModels.filter(m => m.device_type_id === row.deviceTypeId);
  const repairsForModel = repairTypes.filter(r => {
    const dt = deviceTypes.find(d => d.id === row.deviceTypeId);
    return r.device_type_id === row.deviceTypeId;
  });

  const rt = repairTypes.find(r => r.id === row.repairTypeId);
  const isLabor = rt?.is_labor || false;
  const isJoycon = deviceModels.find(m => m.id === row.deviceModelId)?.name?.includes('Joycon');

  const bookMins = isLabor
    ? getLaborBookMinutes(row.repairTypeId, row.laborCost)
    : getBookMinutes(row.repairTypeId, row.deviceModelId, row.isFullSet);

  const actual = parseFloat(row.actualMinutes) || 0;
  const pct = calcEfficiency(row);
  const diff = (actual > 0 && bookMins !== null) ? Math.round(actual - bookMins) : null;
  const diffStr = diff === null ? '—' : (diff > 0 ? `+${diff}` : String(diff));
  const bg = rowBg(pct);

  const inp = (val, onChange, opts = {}) => (
    <input
      value={val}
      onChange={e => onChange(e.target.value)}
      {...opts}
      style={{
        width: '100%', background: '#fff', border: `1px solid ${BORDER}`,
        borderRadius: '6px', fontSize: '12px', padding: '4px 6px',
        fontFamily: 'inherit', color: NAVY, outline: 'none', ...opts.style,
      }}
    />
  );

  return (
    <tr style={{ background: bg, borderBottom: `1px solid ${BLUE_MID}` }}>
      <td style={{ padding: '4px' }}>
        {inp(row.ticketNumber, v => updateRow(row._id, { ticketNumber: v }), { placeholder: String(idx + 1) })}
      </td>
      <td style={{ padding: '4px' }}>
        <select value={row.deviceTypeId} onChange={e => updateRow(row._id, { deviceTypeId: e.target.value, deviceModelId: '', repairTypeId: '' })} style={selStyle}>
          <option value="">— select —</option>
          {deviceTypes.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </td>
      <td style={{ padding: '4px' }}>
        <select value={row.deviceModelId} onChange={e => updateRow(row._id, { deviceModelId: e.target.value, repairTypeId: '' })} disabled={!row.deviceTypeId} style={selStyle}>
          <option value="">— select —</option>
          {modelsForType.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </td>
      <td style={{ padding: '4px' }}>
        <select value={row.repairTypeId} onChange={e => updateRow(row._id, { repairTypeId: e.target.value })} disabled={!row.deviceModelId} style={selStyle}>
          <option value="">— select —</option>
          {repairsForModel.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </td>
      <td style={{ padding: '4px', textAlign: 'center', fontWeight: 700, fontSize: '12px', color: BLUE }}>
        {bookMins !== null ? bookMins : '—'}
      </td>
      <td style={{ padding: '4px' }}>
        {isLabor && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '3px', marginBottom: '3px' }}>
            <span style={{ fontSize: '10px', color: '#888' }}>$</span>
            {inp(row.laborCost, v => updateRow(row._id, { laborCost: v }), { type: 'number', style: { width: '54px' }, placeholder: '0' })}
            <span style={{ fontSize: '10px', color: '#888' }}>labor{bookMins ? ` = ${bookMins}m` : ''}</span>
          </div>
        )}
        {inp(row.actualMinutes, v => updateRow(row._id, { actualMinutes: v }), { type: 'number', placeholder: isLabor ? 'actual mins' : '0' })}
        {isJoycon && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '3px' }}>
            <input type="checkbox" checked={row.isFullSet} onChange={e => updateRow(row._id, { isFullSet: e.target.checked })} />
            <span style={{ fontSize: '11px', color: '#666' }}>full set</span>
          </div>
        )}
      </td>
      <td style={{ padding: '4px', textAlign: 'center', fontWeight: 700, fontSize: '12px', color: diff === null ? '#aac8d8' : diff <= 0 ? GREEN : RED }}>
        {diffStr}
      </td>
      <td style={{ padding: '4px', textAlign: 'center' }}>
        {pct !== null
          ? <span style={{ display: 'inline-block', fontSize: '11px', fontWeight: 700, padding: '2px 7px', borderRadius: '20px', background: pct >= 90 ? GREEN_BG : pct >= 65 ? AMBER_BG : RED_BG, color: pct >= 90 ? GREEN : pct >= 65 ? AMBER : RED }}>{pct}%</span>
          : <span style={{ color: '#aac8d8', fontSize: '11px' }}>—</span>
        }
      </td>
      <td style={{ padding: '4px', minWidth: '110px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, fontVariantNumeric: 'tabular-nums', textAlign: 'center', padding: '2px 0', background: row.timerState === 'running' ? GREEN_BG : row.timerState === 'paused' ? AMBER_BG : '#f5f5f0', borderRadius: '5px', border: `1px solid ${row.timerState === 'running' ? '#a8dbb8' : row.timerState === 'paused' ? '#fcd98a' : BORDER}`, color: row.timerState === 'running' ? GREEN : row.timerState === 'paused' ? AMBER : NAVY, marginBottom: '3px' }}>
          {fmtTimer(row.timerMs)}
        </div>
        <div style={{ display: 'flex', gap: '3px' }}>
          {row.timerState === 'idle' && <TBtn color={GREEN} bg={GREEN_BG} border="#a8dbb8" onClick={() => timerStart(row._id)}>▶ Start</TBtn>}
          {row.timerState === 'running' && <>
            <TBtn color={AMBER} bg={AMBER_BG} border="#fcd98a" onClick={() => timerPause(row._id)}>⏸ Pause</TBtn>
            <TBtn color={RED} bg={RED_BG} border="#f0aaaa" onClick={() => timerStop(row._id)}>■ Stop</TBtn>
          </>}
          {row.timerState === 'paused' && <>
            <TBtn color={BLUE} bg={BLUE_LIGHT} border={BORDER} onClick={() => timerStart(row._id)}>▶ Resume</TBtn>
            <TBtn color={RED} bg={RED_BG} border="#f0aaaa" onClick={() => timerStop(row._id)}>■ Stop</TBtn>
          </>}
        </div>
      </td>
      <td style={{ padding: '4px' }}>
        {inp(row.notes, v => updateRow(row._id, { notes: v }), { placeholder: 'Notes (optional)' })}
      </td>
    </tr>
  );
}

const selStyle = {
  width: '100%', background: '#fff', border: `1px solid #b8dff0`,
  borderRadius: '6px', fontSize: '12px', padding: '4px 6px',
  fontFamily: 'inherit', color: '#1a2a3a', outline: 'none', cursor: 'pointer',
};

function TBtn({ color, bg, border, onClick, children }) {
  return <button onClick={onClick} style={{ flex: 1, border: `1px solid ${border}`, background: bg, color, borderRadius: '5px', padding: '3px 4px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>{children}</button>;
}

function Btn({ onClick, children, danger, primary }) {
  return <button onClick={onClick} style={{
    border: `1px solid ${danger ? '#f0aaaa' : primary ? '#1480b0' : '#d0cdc5'}`,
    background: primary ? '#1B9BD4' : '#fff',
    color: danger ? '#b52020' : primary ? '#fff' : '#1a2a3a',
    borderRadius: '8px', padding: '7px 16px', fontSize: '13px',
    fontWeight: primary ? 700 : 400, cursor: 'pointer', fontFamily: 'inherit',
  }}>{children}</button>;
}
