import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

const BLUE='#1B9BD4',NAVY='#1a2a3a',YELLOW='#F5C518';

export default function Login({onLogin}){
  const [technicians,setTechnicians]=useState([]);
  const [pin,setPin]=useState('');
  const [matchedTech,setMatchedTech]=useState(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  const [showWelcome,setShowWelcome]=useState(false);

  useEffect(()=>{
    supabase.from('technicians').select('*').eq('active',true).order('name')
      .then(({data})=>setTechnicians(data||[]));
  },[]);

  useEffect(()=>{
    if(pin.length>=3){
      const match=technicians.find(t=>t.pin===pin);
      setMatchedTech(match||null);
      setError('');
    } else {
      setMatchedTech(null);
      setError('');
    }
  },[pin,technicians]);

  const handleLogin=()=>{
    if(!pin){setError('Enter your PIN.');return;}
    if(!matchedTech){setError('PIN not recognized. Try again.');return;}
    setShowWelcome(true);
    setTimeout(()=>onLogin(matchedTech),1800);
  };

  const handleKey=(e)=>{if(e.key==='Enter')handleLogin();};

  if(showWelcome&&matchedTech){
    return(
      <div style={{minHeight:'100vh',background:BLUE,display:'flex',alignItems:'center',justifyContent:'center'}}>
        <div style={{textAlign:'center',animation:'fadeIn 0.4s ease'}}>
          <div style={{fontSize:'16px',fontWeight:600,color:'rgba(255,255,255,0.7)',letterSpacing:'0.1em',textTransform:'uppercase',marginBottom:'12px'}}>Welcome back</div>
          <div style={{fontSize:'56px',fontWeight:900,color:YELLOW,letterSpacing:'0.02em',textShadow:'0 2px 20px rgba(0,0,0,0.3)'}}>{matchedTech.name}</div>
          <div style={{marginTop:'24px',fontSize:'14px',color:'rgba(255,255,255,0.5)'}}>Loading your sheet...</div>
        </div>
      </div>
    );
  }

  return(
    <div style={{minHeight:'100vh',background:BLUE,display:'flex',alignItems:'center',justifyContent:'center'}}>
      <div style={{background:'#fff',borderRadius:'16px',padding:'2.5rem 2rem',width:'100%',maxWidth:'360px',boxShadow:'0 8px 40px rgba(0,0,0,0.2)'}}>
        <div style={{textAlign:'center',marginBottom:'2rem'}}>
          <img src={`${process.env.PUBLIC_URL}/logo.png`} alt="Lightning Repairs" style={{height:'48px',marginBottom:'12px'}} onError={e=>{e.target.style.display='none';}}/>
          <div style={{fontSize:'20px',fontWeight:800,color:NAVY,letterSpacing:'0.04em'}}>LIGHTNING REPAIRS</div>
          <div style={{fontSize:'13px',color:BLUE,fontWeight:600,marginTop:'4px'}}>Daily Ticket Tracker</div>
        </div>

        <div style={{marginBottom:'1.5rem'}}>
          <label style={{display:'block',fontSize:'11px',fontWeight:700,color:'#888',textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:'8px',textAlign:'center'}}>Enter your PIN</label>
          <input
            type="password"
            value={pin}
            onChange={e=>setPin(e.target.value)}
            onKeyDown={handleKey}
            placeholder="••••"
            maxLength={6}
            autoFocus
            style={{width:'100%',padding:'14px',fontSize:'24px',textAlign:'center',letterSpacing:'0.3em',border:`2px solid ${matchedTech?'#2d8a4e':pin.length>0?'#e0ddd5':BLUE}`,borderRadius:'10px',outline:'none',fontFamily:'inherit',color:NAVY,background:matchedTech?'#e6f5ec':'#fff',transition:'all 0.2s'}}
          />
          {matchedTech&&(
            <div style={{textAlign:'center',marginTop:'8px',fontSize:'13px',fontWeight:700,color:'#2d8a4e'}}>✓ {matchedTech.name}</div>
          )}
          {error&&<div style={{color:'#b52020',fontSize:'13px',marginTop:'8px',textAlign:'center'}}>{error}</div>}
        </div>

        <button
          onClick={handleLogin}
          disabled={!matchedTech||loading}
          style={{width:'100%',padding:'14px',background:matchedTech?NAVY:'#ccc',color:'#fff',border:'none',borderRadius:'10px',fontSize:'15px',fontWeight:700,cursor:matchedTech?'pointer':'not-allowed',fontFamily:'inherit',transition:'background 0.2s'}}
        >
          {loading?'Signing in...':'Sign In →'}
        </button>

        <div style={{textAlign:'center',marginTop:'16px',fontSize:'11px',color:'#aaa'}}>
          Contact your admin if you need help with your PIN
        </div>
      </div>
    </div>
  );
}
