import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

const BLUE = '#1B9BD4';
const NAVY = '#1a2a3a';
const YELLOW = '#F5C518';

export default function Login({ onLogin }) {
  const [technicians, setTechnicians] = useState([]);
  const [selectedTech, setSelectedTech] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.from('technicians').select('*').eq('active', true).order('name')
      .then(({ data }) => setTechnicians(data || []));
  }, []);

  const handleLogin = async () => {
    if (!selectedTech || !pin) { setError('Please select your name and enter your PIN.'); return; }
    setLoading(true); setError('');
    const tech = technicians.find(t => t.id === selectedTech);
    if (!tech || tech.pin !== pin) {
      setError('Incorrect PIN. Please try again.');
      setLoading(false); return;
    }
    onLogin(tech);
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: '100vh', background: BLUE,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#fff', borderRadius: '16px', padding: '2.5rem 2rem',
        width: '100%', maxWidth: '380px', boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '40px', marginBottom: '8px' }}>⚡</div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: NAVY, letterSpacing: '0.04em' }}>
            LIGHTNING REPAIRS
          </div>
          <div style={{ fontSize: '13px', color: BLUE, fontWeight: 600, marginTop: '4px' }}>
            Daily Ticket Tracker
          </div>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label style={labelStyle}>Who are you?</label>
          <select
            value={selectedTech}
            onChange={e => { setSelectedTech(e.target.value); setError(''); }}
            style={inputStyle}
          >
            <option value="">— Select your name —</option>
            {technicians.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label style={labelStyle}>PIN</label>
          <input
            type="password"
            value={pin}
            onChange={e => { setPin(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            placeholder="Enter your PIN"
            maxLength={6}
            style={inputStyle}
          />
        </div>

        {error && (
          <div style={{ background: '#fce8e8', color: '#b52020', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', marginBottom: '1rem' }}>
            {error}
          </div>
        )}

        <button
          onClick={handleLogin}
          disabled={loading}
          style={{
            width: '100%', background: BLUE, color: '#fff',
            border: 'none', borderRadius: '10px', padding: '12px',
            fontSize: '15px', fontWeight: 700, cursor: 'pointer',
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Signing in...' : 'Sign In'}
        </button>

        <div style={{ textAlign: 'center', marginTop: '1rem', fontSize: '12px', color: '#aaa' }}>
          Don't know your PIN? Ask your manager.
        </div>
      </div>
    </div>
  );
}

const labelStyle = {
  display: 'block', fontSize: '12px', fontWeight: 600,
  color: '#555', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em',
};
const inputStyle = {
  width: '100%', border: '1.5px solid #d0cdc5', borderRadius: '8px',
  padding: '10px 12px', fontSize: '14px', outline: 'none',
  fontFamily: 'inherit', color: '#1a2a3a', background: '#fff',
};
