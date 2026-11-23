import React,{useCallback,useEffect,useMemo,useState} from "react";
import {supabase} from "./supabase";
import Payroll from "./Payroll.jsx";
import {Clock3,Timer,Plus,Users,Receipt,Play,Square,Trash2,RefreshCw,Pencil} from "lucide-react";

const money=n=>"$"+new Intl.NumberFormat("en-US",{maximumFractionDigits:0}).format(Math.round(Number(n||0)));
const duration=(ms)=>{const total=Math.max(0,Math.floor(ms/1000));const h=Math.floor(total/3600),m=Math.floor(total%3600/60),s=total%60;return [h,m,s].map(v=>String(v).padStart(2,"0")).join(":")};
const elapsed=(start,end=null)=>Math.max(0,new Date(end||Date.now()).getTime()-new Date(start).getTime());
const modeLabel=m=>({hourly:"Por hora",per_agent:"Por agente",hourly_per_agent:"Por hora + agente"}[m]||m);
const toLocalInput=value=>{if(!value)return "";const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)};

export default function TariffTime({session,profile,isManager,services,onNotice,onRefreshServices}){
 const [tariffs,setTariffs]=useState([]),[assignments,setAssignments]=useState([]),[entries,setEntries]=useState([]),[shifts,setShifts]=useState([]);
 const [agents,setAgents]=useState([]),[corrections,setCorrections]=useState([]),[now,setNow]=useState(Date.now()),[loading,setLoading]=useState(false);
 const [form,setForm]=useState({name:"",description:"",billing_mode:"hourly",hourly_rate:"",per_agent_rate:""});
 const [servicePick,setServicePick]=useState(""),[tariffPick,setTariffPick]=useState(""),[agentPick,setAgentPick]=useState("");
 const [selected,setSelected]=useState(""),[busyAction,setBusyAction]=useState(false),[editingId,setEditingId]=useState(null),[agentSearch,setAgentSearch]=useState("");
 const [correction,setCorrection]=useState(null),[correctionBusy,setCorrectionBusy]=useState(false);
 const userId=session?.user?.id;
 const load=useCallback(async()=>{
  if(!supabase||!userId)return;
  setLoading(true);
  const [t,a,e,sh,c]=await Promise.all([
   supabase.from("service_tariffs").select("*").order("name"),
   supabase.from("service_assignments").select("*").order("assigned_at",{ascending:false}),
   supabase.from("service_time_entries").select("*").order("started_at",{ascending:false}).limit(250),
   supabase.from("shifts").select("*").order("clock_in",{ascending:false}).limit(250),
   isManager?supabase.from("service_time_corrections").select("*").order("corrected_at",{ascending:false}).limit(250):Promise.resolve({data:[],error:null})
  ]);
  if(t.error)onNotice?.("Tarifario: "+t.error.message);
  if(a.error)onNotice?.("Asignaciones: "+a.error.message);
  if(e.error)onNotice?.("Registro de tiempo: "+e.error.message);
  if(sh.error)onNotice?.("Fichajes: "+sh.error.message);
  if(c.error&&isManager)onNotice?.("Auditoría de fichajes: "+c.error.message);
  setTariffs(t.data||[]);setAssignments(a.data||[]);setEntries(e.data||[]);setShifts(sh.data||[]);setCorrections(c.data||[]);
  if(isManager){const {data:p,error}=await supabase.from("profiles").select("id,full_name,username,role,rank,photo_url").eq("status","approved").in("role",["agent","commander"]).order("full_name");if(error)onNotice?.(error.message);setAgents(p||[])}
  setLoading(false);
 },[userId,isManager,onNotice]);
 useEffect(()=>{load();const timer=setInterval(()=>load(),15000);const channel=supabase?.channel("operations-live-"+userId).on("postgres_changes",{event:"*",schema:"public",table:"shifts"},()=>load()).on("postgres_changes",{event:"*",schema:"public",table:"service_time_entries"},()=>load()).on("postgres_changes",{event:"*",schema:"public",table:"service_assignments"},()=>load()).on("postgres_changes",{event:"*",schema:"public",table:"service_time_corrections"},()=>load()).subscribe();return()=>{clearInterval(timer);if(channel)supabase.removeChannel(channel)}},[load,userId]);
 useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id)},[]);
 const myShift=shifts.find(x=>x.agent_id===userId&&!x.clock_out);
 const myTimer=entries.find(x=>x.agent_id===userId&&!x.ended_at);
 const myAssignments=assignments.filter(x=>x.agent_id===userId);
 const availableServices=services.filter(s=>s.status==="active"&&myAssignments.some(a=>a.service_id===s.id));
 const serviceById=useMemo(()=>Object.fromEntries(services.map(s=>[s.id,s])),[services]);
 const profileById=useMemo(()=>Object.fromEntries(agents.map(a=>[a.id,a])),[agents]);
 const tariffById=useMemo(()=>Object.fromEntries(tariffs.map(t=>[t.id,t])),[tariffs]);
 const serviceAgents=serviceId=>assignments.filter(a=>a.service_id===serviceId);
 const serviceHours=serviceId=>entries.filter(e=>e.service_id===serviceId).reduce((sum,e)=>sum+elapsed(e.started_at,e.ended_at),0)/3600000;
 const serviceWallHours=serviceId=>{const intervals=entries.filter(e=>e.service_id===serviceId).map(e=>[new Date(e.started_at).getTime(),new Date(e.ended_at||Date.now()).getTime()]).sort((a,b)=>a[0]-b[0]);let total=0,start=null,end=null;for(const [a,b] of intervals){if(start===null){start=a;end=b}else if(a<=end){end=Math.max(end,b)}else{total+=end-start;start=a;end=b}}if(start!==null)total+=end-start;return total/3600000};
 const serviceCharge=serviceId=>{
  const s=serviceById[serviceId];if(!s?.billing_mode_snapshot)return null;
  const hours=serviceWallHours(serviceId),count=serviceAgents(serviceId).length;
  if(s.billing_mode_snapshot==="hourly")return hours*Number(s.hourly_rate_snapshot||0);
  if(s.billing_mode_snapshot==="per_agent")return count*Number(s.per_agent_rate_snapshot||0);
  return hours*Number(s.hourly_rate_snapshot||0)+count*Number(s.per_agent_rate_snapshot||0);
 };
 const createTariff=async e=>{
  e.preventDefault();if(!isManager)return;
  const h=Number(form.hourly_rate||0),p=Number(form.per_agent_rate||0);
  if((form.billing_mode!=="per_agent"&&h<=0)||(form.billing_mode!=="hourly"&&p<=0)){onNotice?.("Completa todos los precios correspondientes al tipo de cobro.");return}
  setBusyAction(true);
  const payload={name:form.name.trim(),description:form.description.trim()||null,billing_mode:form.billing_mode,hourly_rate:form.billing_mode==="per_agent"?0:h,per_agent_rate:form.billing_mode==="hourly" ? 0 : p};
  const {error}=editingId?await supabase.from("service_tariffs").update(payload).eq("id",editingId):await supabase.from("service_tariffs").insert({...payload,created_by:userId});
  setBusyAction(false);if(error){onNotice?.(error.message);return}
  setForm({name:"",description:"",billing_mode:"hourly",hourly_rate:"",per_agent_rate:""});setEditingId(null);await load();onNotice?.(editingId?"Tarifa actualizada.":"Tarifa creada.");
 };
 const toggleTariff=async t=>{const {error}=await supabase.from("service_tariffs").update({is_active:!t.is_active}).eq("id",t.id);if(error)onNotice?.(error.message);else load()};
 const applyTariff=async e=>{
  e.preventDefault();if(!servicePick||!tariffPick)return;
  const {error}=await supabase.from("services").update({tariff_id:tariffPick}).eq("id",servicePick);
  if(error){onNotice?.(error.message);return}
  await Promise.all([load(),onRefreshServices?.()]);onNotice?.("Tarifa aplicada. El precio quedó guardado como referencia para este servicio.");
 };
 const assignAgent=async e=>{
  e.preventDefault();if(!servicePick||!agentPick)return;
  const {error}=await supabase.from("service_assignments").insert({service_id:servicePick,agent_id:agentPick,assigned_by:userId});
  if(error){onNotice?.(error.code==="23505"?"Ese agente ya está asignado.":error.message);return}
  setAgentPick("");await load();onNotice?.("Agente asignado al servicio.");
 };
 const removeAssignment=async id=>{const {error}=await supabase.from("service_assignments").delete().eq("id",id);if(error)onNotice?.(error.message);else load()};
 const saveCorrection=async e=>{e.preventDefault();if(!isManager||!correction)return;setCorrectionBusy(true);const {data,error}=await supabase.rpc("correct_service_time_entry",{p_entry_id:correction.id,p_started_at:new Date(correction.started_at).toISOString(),p_ended_at:new Date(correction.ended_at).toISOString(),p_reason:correction.reason});setCorrectionBusy(false);if(error){onNotice?.("No se pudo corregir el fichaje: "+error.message);return}setCorrection(null);await load();onNotice?.("Fichaje corregido y registrado en la auditoría.");};
 const clockIn=async()=>{if(myShift){return}const {error}=await supabase.from("shifts").insert({agent_id:userId});if(error)onNotice?.(error.message);else{await load();onNotice?.("Turno iniciado.")}};
 const clockOut=async()=>{if(myTimer){onNotice?.("Primero detén el contador del servicio.");return}if(!myShift)return;const {error}=await supabase.from("shifts").update({clock_out:new Date().toISOString()}).eq("id",myShift.id);if(error)onNotice?.(error.message);else{await load();onNotice?.("Turno finalizado y guardado.")}};
 const startTimer=async()=>{if(!myShift){onNotice?.("Inicia tu turno antes de comenzar un servicio.");return}if(!selected){onNotice?.("Selecciona un servicio asignado.");return}if(myTimer){onNotice?.("Ya tienes un contador de servicio activo.");return}setBusyAction(true);const {error}=await supabase.from("service_time_entries").insert({service_id:selected,agent_id:userId});setBusyAction(false);if(error)onNotice?.(error.message);else{await load();onNotice?.("Tiempo del servicio en marcha.")}};
 const stopTimer=async()=>{if(!myTimer)return;setBusyAction(true);const {error}=await supabase.from("service_time_entries").update({ended_at:new Date().toISOString()}).eq("id",myTimer.id);setBusyAction(false);if(error)onNotice?.(error.message);else{await load();onNotice?.("Tiempo del servicio guardado.")}};
 const myShiftHistory=shifts.filter(s=>s.agent_id===userId);
 const myEntries=entries.filter(e=>e.agent_id===userId);
 const serviceTotal=arr=>arr.reduce((sum,e)=>sum+elapsed(e.started_at,e.ended_at),0);
 return <section className="content tariff-time">
  <small>CONTROL OPERATIVO</small><h2>Tarifario y <em>fichaje</em></h2>
  <div className="tt-summary">
   <div><span>Estado del turno</span><b>{myShift?"En servicio":"Fuera de turno"}</b><strong>{myShift?duration(elapsed(myShift.clock_in)): "—"}</strong></div>
   <div><span>Tiempo en servicios</span><b>{myTimer?"Contador activo":"Acumulado"}</b><strong>{duration(serviceTotal(myEntries))}</strong></div>
   <div><span>Servicios asignados</span><b>Disponibles para ti</b><strong>{myAssignments.length}</strong></div>
  </div>
  <div className="panel">
   <h3><Clock3 size={18}/> Mi fichaje</h3><p className="muted">El turno mide tu jornada completa. Los contadores de servicios registran por separado el tiempo dedicado a cada asignación.</p>
   <div className="tt-actions">{!myShift?<button className="red" onClick={clockIn}><Play size={16}/> Iniciar turno</button>:<button className="outline" onClick={clockOut} disabled={!!myTimer}><Square size={15}/> Finalizar turno</button>}
   {myShift&&<span className="status active">Turno abierto desde {new Date(myShift.clock_in).toLocaleTimeString("es-PA")}</span>}</div>
   <div className="tt-timer"><div><small>CONTADOR DE SERVICIO</small><strong>{myTimer?duration(elapsed(myTimer.started_at)):"00:00:00"}</strong><span>{myTimer?serviceById[myTimer.service_id]?.name||"Servicio": "Sin servicio en curso"}</span></div>
    {myTimer?<button className="red" onClick={stopTimer} disabled={busyAction}><Square size={15}/> Detener</button>:<div className="tt-start"><select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Seleccionar servicio asignado</option>{availableServices.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><button className="red" onClick={startTimer} disabled={!myShift||!selected||busyAction}><Play size={15}/> Iniciar servicio</button></div>}
   </div>
  </div>
  <div className="panel">
   <h3><Timer size={18}/> Mi historial de servicios</h3>
   {myEntries.length===0?<p className="muted">Todavía no tienes tiempos registrados.</p>:<div className="tt-table"><div className="tt-row tt-head"><b>Servicio</b><b>Inicio</b><b>Final</b><b>Duración</b></div>{myEntries.map(e=><div className="tt-row" key={e.id}><span>{serviceById[e.service_id]?.name||"Servicio"}</span><span>{new Date(e.started_at).toLocaleString("es-PA")}</span><span>{e.ended_at?new Date(e.ended_at).toLocaleString("es-PA"):"En curso"}</span><b>{duration(elapsed(e.started_at,e.ended_at))}</b></div>)}</div>}
   <h4>Mis turnos</h4>{myShiftHistory.slice(0,12).map(s=><div className="tt-history" key={s.id}><span>{new Date(s.clock_in).toLocaleDateString("es-PA")}</span><span>{new Date(s.clock_in).toLocaleTimeString("es-PA")} – {s.clock_out?new Date(s.clock_out).toLocaleTimeString("es-PA"):"En curso"}</span><b>{duration(elapsed(s.clock_in,s.clock_out))}</b></div>)}
  </div>
  {isManager&&<>
   <div className="panel">
    <h3><Receipt size={18}/> {editingId?"Editar tarifa":"Crear tarifa"}</h3><p className="muted">Configura si el cobro será por hora, por agente o combinando ambos. Las tarifas aplicadas a servicios quedan congeladas en ese servicio.</p>
    <form className="tt-form" onSubmit={createTariff}>
     <label>Nombre del servicio<input required value={form.name} onChange={e=>setForm(x=>({...x,name:e.target.value}))} placeholder="Ej. Escolta personal"/></label>
     <label>Modalidad<select value={form.billing_mode} onChange={e=>setForm(x=>({...x,billing_mode:e.target.value}))}><option value="hourly">Por hora</option><option value="per_agent">Por agente</option><option value="hourly_per_agent">Por hora y por agente</option></select></label>
     {form.billing_mode==="hourly"&&<label>Precio por hora ($ del rol)<input required min="0.01" step="0.01" type="number" value={form.hourly_rate} onChange={e=>setForm(x=>({...x,hourly_rate:e.target.value}))}/></label>}
     {form.billing_mode==="per_agent"&&<label>Precio por agente ($ del rol)<input required min="0.01" step="0.01" type="number" value={form.per_agent_rate} onChange={e=>setForm(x=>({...x,per_agent_rate:e.target.value}))}/></label>}
     {form.billing_mode==="hourly_per_agent"&&<><label>Precio por hora ($ del rol)<input required min="0.01" step="0.01" type="number" value={form.hourly_rate} onChange={e=>setForm(x=>({...x,hourly_rate:e.target.value}))}/></label><label>Precio por agente ($ del rol)<input required min="0.01" step="0.01" type="number" value={form.per_agent_rate} onChange={e=>setForm(x=>({...x,per_agent_rate:e.target.value}))}/></label></>}
     <label className="tt-wide">Descripción<textarea value={form.description} onChange={e=>setForm(x=>({...x,description:e.target.value}))}/></label>
     <div className="tt-form-actions"><button className="red" disabled={busyAction}><Plus size={15}/> {editingId?"Guardar cambios":"Guardar tarifa"}</button>{editingId&&<button type="button" className="outline" onClick={()=>{setEditingId(null);setForm({name:"",description:"",billing_mode:"hourly",hourly_rate:"",per_agent_rate:""})}}>Cancelar edición</button>}</div>
    </form>
    <div className="tt-tariffs">{tariffs.map(t=><article key={t.id}><div><b>{t.name}</b><small>{modeLabel(t.billing_mode)} · {t.billing_mode==="hourly"?money(t.hourly_rate)+" / hora":t.billing_mode==="per_agent"?money(t.per_agent_rate)+" / agente":money(t.hourly_rate)+" / hora + "+money(t.per_agent_rate)+" / agente"}</small></div><div className="tt-tariff-actions"><button className="outline" onClick={()=>{setEditingId(t.id);setForm({name:t.name,description:t.description||"",billing_mode:t.billing_mode,hourly_rate:t.billing_mode==="per_agent"?"":String(t.hourly_rate),per_agent_rate:t.billing_mode==="hourly"?"":String(t.per_agent_rate)})}}><Pencil size={13}/> Editar</button><button className="outline" onClick={()=>toggleTariff(t)}>{t.is_active?"Desactivar":"Activar"}</button></div></article>)}</div>
   </div>
   <div className="panel">
    <h3><Users size={18}/> Asignar tarifas y agentes</h3>
    <form className="tt-form" onSubmit={applyTariff}>
     <label>Servicio operativo<select required value={servicePick} onChange={e=>setServicePick(e.target.value)}><option value="">Seleccionar servicio</option>{services.filter(s=>s.status!=="completed").map(s=><option key={s.id} value={s.id}>{s.name} · {s.status}</option>)}</select></label>
     <label>Tarifa<select required value={tariffPick} onChange={e=>setTariffPick(e.target.value)}><option value="">Seleccionar tarifa</option>{tariffs.filter(t=>t.is_active).map(t=><option key={t.id} value={t.id}>{t.name} · {modeLabel(t.billing_mode)}</option>)}</select></label>
     <button className="red">Aplicar tarifa</button>
    </form>
    <form className="tt-form tt-assign" onSubmit={assignAgent}>
     <label>Servicio<select required value={servicePick} onChange={e=>setServicePick(e.target.value)}><option value="">Seleccionar servicio</option>{services.filter(s=>s.status!=="completed").map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
     <label>Buscar agente<input value={agentSearch} onChange={e=>setAgentSearch(e.target.value)} placeholder="Buscar por nombre o usuario..."/></label>
     <div className="tt-agent-picker tt-wide">{agents.filter(a=>(a.full_name+" "+a.username+" "+(a.rank||"")).toLowerCase().includes(agentSearch.toLowerCase())).map(a=><button type="button" key={a.id} className={agentPick===a.id?"chosen":""} onClick={()=>setAgentPick(a.id)}><img src={a.photo_url||"/avatar-placeholder.svg"} alt=""/><span><b>{a.full_name}</b><small>{a.rank||a.role} · @{a.username}</small></span>{agentPick===a.id&&<strong>Seleccionado</strong>}</button>)}</div>
     <button className="outline" disabled={!agentPick||!servicePick}><Plus size={15}/> Asignar agente seleccionado</button>
    </form>
    {services.map(s=><article className="tt-service" key={s.id}><div><b>{s.name}</b><small>{s.tariff_name_snapshot||"Sin tarifa aplicada"} · {serviceAgents(s.id).length} agentes · {duration(serviceHours(s.id)*3600000)} agente-horas · {duration(serviceWallHours(s.id)*3600000)} horas de servicio</small><small>{s.billing_total_snapshot!=null?"Total final: "+money(s.billing_total_snapshot):"Estimado: "+(s.billing_mode_snapshot?money(serviceCharge(s.id)):"Sin tarifar")}</small></div><div className="tt-assigned">{serviceAgents(s.id).map(a=><span key={a.id}>{profileById[a.agent_id]?.full_name||a.agent_id.slice(0,8)} <button onClick={()=>removeAssignment(a.id)} title="Quitar asignación"><Trash2 size={12}/></button></span>)}</div></article>)}
   </div>
   <div className="panel"><h3><HistoryIcon/> Registro global de horas</h3><p className="muted">Vista de Dirección de los últimos 250 registros. Las correcciones quedan guardadas con usuario, fecha y motivo.</p>{entries.map(e=><div className="tt-history" key={e.id}><span>{profileById[e.agent_id]?.full_name||e.agent_id.slice(0,8)} · {serviceById[e.service_id]?.name||"Servicio"}</span><span>{new Date(e.started_at).toLocaleString("es-PA")}</span><b>{duration(elapsed(e.started_at,e.ended_at))}</b>{isManager&&<button type="button" className="outline" onClick={()=>setCorrection({id:e.id,started_at:toLocalInput(e.started_at),ended_at:toLocalInput(e.ended_at||new Date().toISOString()),reason:""})}><Pencil size={13}/> Corregir</button>}</div>)}<div className="tt-audit"><h4>Historial de modificaciones</h4>{corrections.length===0?<p className="muted">Todavía no hay correcciones registradas.</p>:corrections.map(x=><div className="tt-history" key={x.id}><span><b>{profileById[x.agent_id]?.full_name||x.agent_id.slice(0,8)}</b> · {serviceById[x.service_id]?.name||"Servicio"}<small>Motivo: {x.reason}</small></span><span>{new Date(x.corrected_at).toLocaleString("es-PA")}<small>Antes: {new Date(x.old_started_at).toLocaleString("es-PA")} – {x.old_ended_at?new Date(x.old_ended_at).toLocaleString("es-PA"):"Abierto"}</small><small>Después: {new Date(x.new_started_at).toLocaleString("es-PA")} – {x.new_ended_at?new Date(x.new_ended_at).toLocaleString("es-PA"):"Abierto"}</small></span><b>{profileById[x.corrected_by]?.full_name||"Dirección"}</b></div>)}</div>{correction&&<form className="tt-form" onSubmit={saveCorrection}><h4 className="tt-wide">Corregir registro de tiempo</h4><label>Inicio<input required type="datetime-local" value={correction.started_at} onChange={e=>setCorrection(x=>({...x,started_at:e.target.value}))}/></label><label>Final<input required type="datetime-local" value={correction.ended_at} onChange={e=>setCorrection(x=>({...x,ended_at:e.target.value}))}/></label><label className="tt-wide">Motivo obligatorio<textarea required minLength="5" maxLength="1000" value={correction.reason} onChange={e=>setCorrection(x=>({...x,reason:e.target.value}))} placeholder="Explica por qué se corrige este fichaje."/></label><div className="tt-form-actions"><button className="red" disabled={correctionBusy}>Guardar corrección</button><button type="button" className="outline" onClick={()=>setCorrection(null)}>Cancelar</button></div></form>}</div>
  </>}
  <Payroll session={session} isManager={isManager} onNotice={onNotice}/>
  {loading&&<p className="muted"><RefreshCw size={14}/> Actualizando registros…</p>}
 </section>;
}
function HistoryIcon(){return <Clock3 size={18}/>;}
