import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

const BLUE = '#1B9BD4';
const NAVY = '#1a2a3a';
const YELLOW = '#F5C518';
const GREEN = '#2d8a4e';
const GREEN_BG = '#e6f5ec';
const AMBER = '#9a6000';
const AMBER_BG = '#fff3d0';
const RED = '#b52020';
const RED_BG = '#fce8e8';
const BORDER = '#b8dff0';

function effColor(pct) {
  if (pct === null || pct === undefined) return '#aac8d8';
  return pct >= 90 ? GREEN : pct >= 65 ? AMBER : RED;
}

export default function ManagerDashboard() {
  const [tickets, setTickets] = useState([]);
  const [technicians, setTechnicians] = useState([]);
  const [repairTypes, setRepairTypes] = useState([]);
  const [deviceTypes, setDeviceTypes] = useState([]);
  const [deviceModels, setDeviceModels] = useState([]);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().slice(0, 10));
  const [selectedTech, setSelectedTech] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const [tech, rt, dt, dm] = await Promise.all([
        supabase.from('technicians').select('*').eq('active', true).order('name'),
        supabase.from('repair_types').select('*'),
        supabase.from('device_types').select('*'),
        supabase.from('device_models').select('*'),
      ]);
      setTechnicians(tech.data || []);
      setRepairTypes(rt.data || []);
      setDeviceTypes(dt.data || []);
      setDeviceModels(dm.data || []);
    };
    load();
  }, []);

  useEffect(() => {
    loadTickets();
    // Real-time subscription
    const sub = supabase.channel('tickets-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, loadTickets)
      .subscribe();
    return () => supabase.removeChannel(sub);
  }, [selectedDate]);

  const loadTickets = async () => {
    setLoading(true);
    const { data } = await supabase.from('tickets').select('*').eq('work_date', selectedDate).order('created_at');
    setTickets(data || []);
    setLoading(false);
  };

  const filtered = selectedTech === 'all' ? tickets : tickets.filter(t => t.technician_id === selectedTech);

  // Group by technician
  const byTech = technicians.map(tech => {
    const techTickets = filtered.filter(t => t.technician_id === tech.id);
    const timed = techTickets.filter(t => t.actual_minutes > 0 && t.book_minutes > 0);
    const totalActual = timed.reduce((s, t) => s + t.actual_minutes, 0);
    const totalBook = timed.reduce((s, t) => s + t.book_minutes, 0);
    const avgEff = timed.length > 0 ? Math.round((totalBook / totalActual) * 100) : null;
    const repaired = techTickets.filter(t => {
      const rt = repairTypes.find(r => r.id === t.repair_type_id);
      return rt && !rt.is_diagnosis;
    });
    const diagnosed = techTickets.filter(t => {
      const rt = repairTypes.find(r => r.id === t.repair_type_id);
      return rt?.is_diagnosis;
    });
    return { tech, tickets: techTickets, timed, totalActual, totalBook, avgEff, repaired, diagnosed };
  }).filter(g => g.tickets.length > 0 || selectedTech === 'all');

  return (
    <div style={{ maxWidth: '1300px', margin: '0 auto' }}>
      {/* Controls */}
      <div style={{ background: '#fff', borderRadius: '12px', padding: '1rem 1.5rem', marginBottom: '1rem', display: 'flex', gap: '16px', alignItems: 'center', border: `1.5px solid ${BORDER}`, flexWrap: 'wrap' }}>
        <div>
          <label style={labelStyle}>Date</label>
          <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Technician</label>
          <select value={selectedTech} onChange={e => setSelectedTech(e.target.value)} style={inputStyle}>
            <option value="all">All technicians</option>
            {technicians.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#2d8a4e', boxShadow: '0 0 0 3px #e6f5ec' }} />
          <span style={{ fontSize: '12px', color: '#666' }}>Live — updates automatically</span>
        </div>
      </div>

      {loading && <div style={{ color: '#fff', textAlign: 'center', padding: '2rem' }}>Loading...</div>}

      {/* Summary cards */}
      {byTech.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          {byTech.map(({ tech, tickets: tt, repaired, diagnosed, avgEff, totalActual, totalBook }) => (
            <div key={tech.id} style={{ background: NAVY, borderRadius: '12px', padding: '1rem 1.25rem', border: '1px solid rgba(255,255,255,0.1)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: '15px' }}>{tech.name}</div>
                <div style={{ background: avgEff === null ? 'rgba(255,255,255,0.1)' : (avgEff >= 90 ? GREEN_BG : avgEff >= 65 ? AMBER_BG : RED_BG), color: avgEff === null ? '#aac8d8' : effColor(avgEff), fontWeight: 800, fontSize: '16px', padding: '3px 12px', borderRadius: '20px' }}>
                  {avgEff === null ? '—' : `${avgEff}%`}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                {[['Tickets', tt.length], ['Repaired', repaired.length], ['Diagnosed', diagnosed.length]].map(([l, v]) => (
                  <div key={l} style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '6px', padding: '6px 8px' }}>
                    <div style={{ fontSize: '9px', color: '#7aafc8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{l}</div>
                    <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff' }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' }}>
                {[['Book Time', totalBook > 0 ? `${totalBook}m` : '—'], ['Actual Time', totalActual > 0 ? `${totalActual}m` : '—']].map(([l, v]) => (
                  <div key={l} style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '6px', padding: '6px 8px' }}>
                    <div style={{ fontSize: '9px', color: '#7aafc8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{l}</div>
                    <div style={{ fontSize: '16px', fontWeight: 700, color: YELLOW }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail table */}
      {filtered.length > 0 && (
        <div style={{ background: '#fff', borderRadius: '12px', border: `1.5px solid ${BORDER}`, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: '900px' }}>
              <thead>
                <tr style={{ background: NAVY }}>
                  {['Technician','Ticket #','Device','Repair','Book','Actual','+/−','Efficiency','Notes'].map(h => (
                    <th key={h} style={{ padding: '8px 8px', textAlign: 'left', fontSize: '10px', color: '#7aafc8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, borderBottom: `2px solid ${BLUE}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => {
                  const tech = technicians.find(x => x.id === t.technician_id);
                  const rt = repairTypes.find(x => x.id === t.repair_type_id);
                  const dt = deviceTypes.find(x => x.id === t.device_type_id);
                  const dm = deviceModels.find(x => x.id === t.device_model_id);
                  const pct = t.efficiency_pct;
                  const diff = (t.actual_minutes && t.book_minutes) ? t.actual_minutes - t.book_minutes : null;
                  const bg = pct === null ? 'transparent' : pct >= 90 ? GREEN_BG : pct >= 65 ? AMBER_BG : RED_BG;
                  return (
                    <tr key={t.id} style={{ background: bg, borderBottom: `1px solid #e8f0f5` }}>
                      <td style={{ padding: '6px 8px', fontWeight: 600 }}>{tech?.name || '—'}</td>
                      <td style={{ padding: '6px 8px' }}>{t.ticket_number || '—'}</td>
                      <td style={{ padding: '6px 8px' }}>{dt?.name} {dm ? `/ ${dm.name}` : ''}</td>
                      <td style={{ padding: '6px 8px' }}>{rt?.name || '—'}</td>
                      <td style={{ padding: '6px 8px', fontWeight: 700, color: BLUE }}>{t.book_minutes ?? '—'}</td>
                      <td style={{ padding: '6px 8px' }}>{t.actual_minutes ?? '—'}</td>
                      <td style={{ padding: '6px 8px', fontWeight: 700, color: diff === null ? '#aac8d8' : diff <= 0 ? GREEN : RED }}>{diff === null ? '—' : diff > 0 ? `+${diff}` : diff}</td>
                      <td style={{ padding: '6px 8px' }}>
                        {pct !== null ? <span style={{ display: 'inline-block', fontSize: '11px', fontWeight: 700, padding: '2px 7px', borderRadius: '20px', background: pct >= 90 ? GREEN_BG : pct >= 65 ? AMBER_BG : RED_BG, color: effColor(pct) }}>{pct}%</span> : '—'}
                      </td>
                      <td style={{ padding: '6px 8px', color: '#666' }}>{t.notes || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div style={{ background: '#fff', borderRadius: '12px', padding: '3rem', textAlign: 'center', color: '#aaa', border: `1.5px solid ${BORDER}` }}>
          No tickets logged for this date yet.
        </div>
      )}
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: '11px', fontWeight: 600, color: '#555', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' };
const inputStyle = { border: '1.5px solid #d0cdc5', borderRadius: '8px', padding: '7px 10px', fontSize: '13px', outline: 'none', fontFamily: 'inherit', color: '#1a2a3a', background: '#fff' };
