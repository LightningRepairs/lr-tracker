import React, { useState, useEffect } from 'react';
import Login from './components/Login';
import TechSheet from './components/TechSheet';
import ManagerDashboard from './components/ManagerDashboard';
import AdminPanel from './components/AdminPanel';
import { supabase } from './lib/supabase';

const COLORS = {
  blue: '#1B9BD4',
  blueDark: '#1480b0',
  blueLight: '#e8f6fc',
  navy: '#1a2a3a',
  yellow: '#F5C518',
  white: '#ffffff',
};

export { COLORS };

export default function App() {
  const [currentTech, setCurrentTech] = useState(null);
  const [view, setView] = useState('login'); // login | tech | manager | admin

  useEffect(() => {
    const saved = sessionStorage.getItem('lr_tech');
    if (saved) {
      const tech = JSON.parse(saved);
      setCurrentTech(tech);
      setView(tech.role === 'admin' || tech.role === 'manager' ? 'manager' : 'tech');
    }
  }, []);

  const handleLogin = (tech) => {
    sessionStorage.setItem('lr_tech', JSON.stringify(tech));
    setCurrentTech(tech);
    setView(tech.role === 'admin' || tech.role === 'manager' ? 'manager' : 'tech');
  };

  const handleLogout = () => {
    sessionStorage.removeItem('lr_tech');
    setCurrentTech(null);
    setView('login');
  };

  if (view === 'login') return <Login onLogin={handleLogin} />;

  return (
    <div style={{ minHeight: '100vh', background: COLORS.blue }}>
      <NavBar
        tech={currentTech}
        view={view}
        setView={setView}
        onLogout={handleLogout}
      />
      <div style={{ padding: '1rem' }}>
        {view === 'tech' && <TechSheet tech={currentTech} />}
        {view === 'manager' && <ManagerDashboard />}
        {view === 'admin' && <AdminPanel />}
      </div>
    </div>
  );
}

function NavBar({ tech, view, setView, onLogout }) {
  return (
    <div style={{
      background: COLORS.navy,
      padding: '0.75rem 1.5rem',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottom: `3px solid ${COLORS.blue}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '22px' }}>⚡</span>
        <div>
          <div style={{ color: COLORS.white, fontWeight: 800, fontSize: '15px', letterSpacing: '0.05em' }}>
            LIGHTNING REPAIRS
          </div>
          <div style={{ color: COLORS.yellow, fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Daily Ticket Tracker
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <NavBtn active={view === 'tech'} onClick={() => setView('tech')}>My Sheet</NavBtn>
        {(tech?.role === 'admin' || tech?.role === 'manager') && <NavBtn active={view === 'manager'} onClick={() => setView('manager')}>Manager View</NavBtn>}
        {tech?.role === 'admin' && <NavBtn active={view === 'admin'} onClick={() => setView('admin')}>Admin Panel</NavBtn>}
        <div style={{ color: 'rgba(255,255,255,0.5)', margin: '0 4px' }}>|</div>
        <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '13px' }}>{tech?.name}</div>
        <button onClick={onLogout} style={{
          background: 'transparent', border: '1px solid rgba(255,255,255,0.3)',
          color: 'rgba(255,255,255,0.7)', borderRadius: '6px', padding: '4px 10px',
          fontSize: '12px', cursor: 'pointer',
        }}>Log out</button>
      </div>
    </div>
  );
}

function NavBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: active ? COLORS.blue : 'transparent',
      border: `1px solid ${active ? COLORS.blue : 'rgba(255,255,255,0.2)'}`,
      color: active ? COLORS.white : 'rgba(255,255,255,0.6)',
      borderRadius: '6px', padding: '5px 14px',
      fontSize: '12px', fontWeight: active ? 700 : 400,
      cursor: 'pointer', transition: 'all 0.15s',
    }}>{children}</button>
  );
}
