import React,{useCallback,useEffect,useMemo,useState} from "react";
import {supabase} from "./supabase";
import {Wallet,Plus,CalendarDays,CheckCircle2,Clock3,RefreshCw,Save} from "lucide-react";
const money=n=>"$"+new Intl.NumberFormat("en-US",{maximumFractionDigits:0}).format(Math.round(Number(n||0)));
const dateKey=d=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const duration=n=>{const h=Math.floor(n),m=Math.round((n-h)*60);return h+" h "+String(m).padStart(2,"0")+" min"};
function defaultPeriod(){const d=new Date();d.setHours(0,0,0,0);const start=new Date(d);start.setDate(d.getDate()-d.getDay()-7);const end=new Date(start);end.setDate(start.getDate()+6);return [dateKey(start),dateKey(end)]}
export default function Payroll({session,isManager,onNotice}){
 const [agents,setAgents]=useState([]),[shifts,setShifts]=useState([]),[rates,setRates]=useState([]),[payments,setPayments]=useState([]);
 const [period,setPeriod]=useState(defaultPeriod),[rank,setRank]=useState("Agente Aprendiz"),[rate,setRate]=useState(""),[busy,setBusy]=useState(false);
 const notify=useCallback(m=>onNotice?.(m),[onNotice]);
 const load=useCallback(async()=>{
  if(!session?.user?.id)return;
  const [p,s,r,w]=await Promise.all([
   isManager?supabase.from("profiles").select("id,full_name,username,rank,role,iban,photo_url").eq("status","approved").in("role",["agent","commander"]).order("full_name"):supabase.from("profiles").select("id,full_name,username,rank,role,iban,photo_url").eq("id",session.user.id),
   isManager?supabase.from("shifts").select("*").order("clock_in",{ascending:false}).limit(1500):supabase.from("shifts").select("*").eq("agent_id",session.user.id).order("clock_in",{ascending:false}).limit(250),
   supabase.from("rank_pay_rates").select("*").order("rank"),
   isManager?supabase.from("weekly_payments").select("*").order("period_start",{ascending:false}).limit(500):supabase.from("weekly_payments").select("*").eq("agent_id",session.user.id).order("period_start",{ascending:false}).limit(100)
  ]);
  for(const x of [p,s,r,w])if(x.error)notify("Nómina: "+x.error.message);
  setAgents(p.data||[]);setShifts(s.data||[]);setRates(r.data||[]);setPayments(w.data||[]);
 },[session?.user?.id,isManager,notify]);
 useEffect(()=>{load();const channel=supabase.channel("payroll-live-"+session?.user?.id).on("postgres_changes",{event:"*",schema:"public",table:"weekly_payments"},load).on("postgres_changes",{event:"*",schema:"public",table:"rank_pay_rates"},load).on("postgres_changes",{event:"*",schema:"public",table:"shifts"},load).subscribe();return()=>supabase.removeChannel(channel)},[load,session?.user?.id]);
 const currentAgent=agents.find(a=>a.id===session?.user?.id);
 const startMs=new Date(period[0]+"T00:00:00").getTime(),endMs=new Date(period[1]+"T23:59:59.999").getTime();
 const hoursFor=id=>shifts.filter(s=>s.agent_id===id).reduce((sum,s)=>{const a=Math.max(startMs,new Date(s.clock_in).getTime()),b=Math.min(endMs,new Date(s.clock_out||Date.now()).getTime());return sum+Math.max(0,b-a)},0)/3600000;
 const rateFor=rankName=>Number(rates.find(r=>r.rank===rankName&&r.is_active)?.hourly_rate||0);
 const preview=useMemo(()=>agents.map(a=>{const hours=hoursFor(a.id),hourly=rateFor(a.rank);const existing=payments.find(p=>p.agent_id===a.id&&p.period_start===period[0]&&p.period_end===period[1]);return {...a,hours,hourly,amount:hours*hourly,existing}}),[agents,shifts,rates,payments,period[0],period[1]]);
 async function saveRate(e){e.preventDefault();if(!isManager||!rank.trim()||Number(rate)<0)return;const {error}=await supabase.from("rank_pay_rates").upsert({rank:rank.trim(),hourly_rate:Number(rate),is_active:true,updated_by:session.user.id},{onConflict:"rank"});if(error)notify(error.message);else{setRate("");await load();notify("Tarifa por rango guardada.")}}
 async function generate(){if(!isManager)return;if(period[1]<period[0]){notify("La fecha final debe ser posterior a la inicial.");return}setBusy(true);let created=0,skipped=0;for(const a of preview){if(a.existing||a.hours<=0||a.hourly<=0){skipped++;continue}const {error}=await supabase.from("weekly_payments").insert({agent_id:a.id,period_start:period[0],period_end:period[1],total_hours:Number(a.hours.toFixed(4)),hourly_rate:a.hourly,amount:Math.round(a.amount),status:"pending"});if(error){if(error.code==="23505")skipped++;else notify("No se pudo generar el pago de "+a.full_name+": "+error.message)}else created++}setBusy(false);await load();notify("Nómina generada: "+created+" pagos nuevos. "+skipped+" omitidos (sin horas, sin tarifa o ya existentes).")}
 async function markPaid(p){if(!isManager)return;const {error}=await supabase.from("weekly_payments").update({status:"paid",paid_at:new Date().toISOString(),paid_by:session.user.id}).eq("id",p.id);if(error)notify(error.message);else{await load();notify("Pago marcado como realizado.")}}
 const staffPayments=isManager?payments:payments.filter(p=>p.agent_id===session?.user?.id);
 const agentById=Object.fromEntries(agents.map(a=>[a.id,a]));
 return <div className="panel payroll-panel">
  <div className="payroll-heading"><div><h3><Wallet size={18}/> Pagos dominicales</h3><p className="muted">La nómina se calcula con las horas del fichaje general, no con el contador de un servicio. El sistema multiplica las horas por la tarifa del rango.</p></div><span className="status active">Cierre semanal</span></div>
  {isManager&&<>
   <form className="payroll-rate-form" onSubmit={saveRate}><label>Rango<input value={rank} onChange={e=>setRank(e.target.value)} placeholder="Ej. Agente Junior" required/></label><label>Pago por hora<input type="number" min="0" step="1" value={rate} onChange={e=>setRate(e.target.value)} placeholder="Ej. 20000" required/></label><button className="red"><Save size={14}/> Guardar tarifa</button></form>
   <div className="payroll-rates">{rates.map(r=><div key={r.id}><span>{r.rank}</span><b>{money(r.hourly_rate)} / hora</b></div>)}</div>
   <div className="payroll-period"><label>Desde<input type="date" value={period[0]} onChange={e=>setPeriod([e.target.value,period[1]])}/></label><label>Hasta<input type="date" value={period[1]} onChange={e=>setPeriod([period[0],e.target.value])}/><small>Periodo que se pagará el domingo.</small></label><button className="red" onClick={generate} disabled={busy}><CalendarDays size={15}/>{busy?"Calculando...":"Generar nómina"}</button></div>
   <div className="payroll-table"><div className="payroll-row payroll-head"><b>Personal</b><b>Horas</b><b>Tarifa</b><b>Total</b><b>Estado</b></div>{preview.map(a=><div className="payroll-row" key={a.id}><span><b>{a.full_name}</b><small>{a.rank||a.role} · IBAN: {a.iban||"Sin registrar"}</small></span><span>{duration(a.hours)}</span><span>{money(a.hourly)}</span><b>{money(a.amount)}</b><span>{a.existing?<em>{a.existing.status==="paid"?"Pagado":"Generado"}</em>:a.hours>0&&a.hourly>0?"Pendiente de generar":"—"}</span></div>)}</div>
  </>}
  {!isManager&&<div className="payroll-my-rate"><span>Mi rango: <b>{currentAgent?.rank||"Agente"}</b></span><span>Tarifa: <b>{money(rateFor(currentAgent?.rank))} / hora</b></span></div>}
  <h4>Historial de pagos</h4>
  {staffPayments.length===0?<p className="muted">Todavía no hay pagos registrados.</p>:<div className="payroll-history">{staffPayments.map(p=><article key={p.id}><div><b>{agentById[p.agent_id]?.full_name||(p.agent_id===session?.user?.id?profileName(currentAgent):"Personal")}</b><small>{p.period_start} al {p.period_end} · {duration(Number(p.total_hours||0))} · {money(p.hourly_rate)}/hora</small></div><strong>{money(p.amount)}</strong><span className={"status "+p.status}>{p.status==="paid"?"Pagado":"Pendiente"}</span>{isManager&&p.status!=="paid"&&<button className="outline" onClick={()=>markPaid(p)}><CheckCircle2 size={14}/> Marcar pagado</button>}{p.status==="paid"&&<small>Pagado el {new Date(p.paid_at).toLocaleDateString("es-PA")}</small>}</article>)}</div>}
  <p className="payroll-footnote">El IBAN se conserva en el expediente del agente para realizar el depósito. Marcar un pago como realizado deja constancia de la fecha y del administrador que lo registró.</p>
 </div>;
}
function profileName(p){return p?.full_name||"Mi cuenta";}
