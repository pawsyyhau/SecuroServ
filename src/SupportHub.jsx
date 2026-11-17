import React,{useCallback,useEffect,useMemo,useState} from "react";
import {MessageCircle,Users,Contact,Send,Search,RefreshCw,Star,Clock3,ShieldCheck,UserRound,ChevronLeft} from "lucide-react";
import "./support-hub.css";

const roleLabel = role => ({director:"Director",admin:"Administrador",commander:"Comandante",agent:"Agente",customer:"Cliente"}[role]||role);
const dateLabel = value => value ? new Date(value).toLocaleString("es-PA",{dateStyle:"medium",timeStyle:"short"}) : "—";

export default function SupportHub({supabase,session,profile,isManager}) {
  const [tab,setTab]=useState(isManager?"inbox":"messages");
  const [conversations,setConversations]=useState([]);
  const [selected,setSelected]=useState(null);
  const [messages,setMessages]=useState([]);
  const [draft,setDraft]=useState("");
  const [members,setMembers]=useState([]);
  const [clients,setClients]=useState([]);
  const [clientDetails,setClientDetails]=useState(null);
  const [history,setHistory]=useState([]);
  const [reviews,setReviews]=useState([]);
  const [query,setQuery]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");

  const loadConversations=useCallback(async()=>{
    if(!supabase||!session)return;
    const {data,error}=await supabase.from("support_conversations").select("*").order("last_message_at",{ascending:false});
    if(error){setError(error.message);return;}
    setConversations(data||[]);
    if(!isManager && data?.length && !selected) setSelected(data[0]);
    if(selected && data?.length){const current=data.find(x=>x.id===selected.id);if(current)setSelected(current);}
  },[supabase,session,isManager,selected]);

  const ensureConversation=useCallback(async()=>{
    if(!supabase||!session||!profile||!["customer","agent"].includes(profile.role))return;
    const {data:existing,error:findError}=await supabase.from("support_conversations").select("*").eq("owner_user_id",session.user.id).maybeSingle();
    if(findError){setError(findError.message);return;}
    if(existing){setSelected(existing);return;}
    const {data,error:createError}=await supabase.from("support_conversations").insert({
      owner_user_id:session.user.id,owner_role:profile.role,owner_name:profile.full_name,
      subject:profile.role==="agent"?"Atención al agente":"Atención al cliente"
    }).select("*").single();
    if(createError){setError(createError.message);return;}
    setSelected(data);setConversations([data]);
  },[supabase,session,profile]);

  useEffect(()=>{loadConversations();},[loadConversations]);
  useEffect(()=>{if(!isManager)ensureConversation();},[isManager,ensureConversation]);

  useEffect(()=>{
    if(!supabase||!session)return;
    const channel=supabase.channel("support-inbox-"+session.user.id)
      .on("postgres_changes",{event:"*",schema:"public",table:"support_conversations"},()=>loadConversations())
      .subscribe();
    return()=>{supabase.removeChannel(channel)};
  },[supabase,session,loadConversations]);

  useEffect(()=>{
    if(!supabase||!selected)return;
    let alive=true;
    (async()=>{
      const {data,error}=await supabase.from("support_messages").select("*").eq("conversation_id",selected.id).order("created_at");
      if(alive){if(error)setError(error.message);else setMessages(data||[]);}
    })();
    const channel=supabase.channel("support-thread-"+selected.id)
      .on("postgres_changes",{event:"INSERT",schema:"public",table:"support_messages",filter:"conversation_id=eq."+selected.id},payload=>{
        setMessages(current=>current.some(x=>x.id===payload.new.id)?current:[...current,payload.new]);
      }).subscribe();
    return()=>{alive=false;supabase.removeChannel(channel)};
  },[supabase,selected?.id]);

  useEffect(()=>{
    if(!isManager||!supabase)return;
    let alive=true;
    (async()=>{
      const {data,error}=await supabase.from("profiles").select("id,full_name,username,phone,role,status,rank,photo_url,discord,discord_id,created_at").in("role",["agent","commander","admin","director"]).order("full_name");
      if(alive){if(error)setError(error.message);else setMembers(data||[]);}
      const {data:customerData,error:customerError}=await supabase.from("profiles").select("id,full_name,username,phone,status,photo_url,created_at,contact_email").eq("role","customer").order("full_name");
      if(alive){if(customerError)setError(customerError.message);else setClients(customerData||[]);}
    })();
    const channel=supabase.channel("staff-directory")
      .on("postgres_changes",{event:"*",schema:"public",table:"profiles"},()=>{ 
        supabase.from("profiles").select("id,full_name,username,phone,role,status,rank,photo_url,discord,discord_id,created_at").in("role",["agent","commander","admin","director"]).order("full_name").then(({data})=>{if(alive)setMembers(data||[])});
        supabase.from("profiles").select("id,full_name,username,phone,status,photo_url,created_at,contact_email").eq("role","customer").order("full_name").then(({data})=>{if(alive)setClients(data||[])});
      }).subscribe();
    return()=>{alive=false;supabase.removeChannel(channel)};
  },[isManager,supabase]);

  async function sendMessage(event){
    event.preventDefault();
    if(!draft.trim()||!selected)return;
    const body=draft.trim();setDraft("");
    const {error}=await supabase.from("support_messages").insert({conversation_id:selected.id,body});
    if(error){setError(error.message);setDraft(body);}
  }
  async function chooseClient(client){
    setClientDetails(client);setHistory([]);setReviews([]);
    const [a,r]=await Promise.all([
      supabase.from("appointments").select("id,date,start_time,end_time,details,status,created_at,assigned_agents").eq("customer_user_id",client.id).order("created_at",{ascending:false}),
      supabase.from("reviews").select("id,rating,comment,created_at,agent_id,appointment_id").eq("customer_user_id",client.id).order("created_at",{ascending:false})
    ]);
    setHistory(a.data||[]);setReviews(r.data||[]);
    if(a.error||r.error)setError(a.error?.message||r.error?.message||"No se pudo cargar el historial.");
  }
  const filteredConversations=useMemo(()=>conversations.filter(c=>(c.owner_name+" "+c.owner_role+" "+c.subject).toLowerCase().includes(query.toLowerCase())),[conversations,query]);
  const filteredMembers=useMemo(()=>members.filter(p=>(p.full_name+" "+p.username+" "+p.rank).toLowerCase().includes(query.toLowerCase())),[members,query]);
  const filteredClients=useMemo(()=>clients.filter(p=>(p.full_name+" "+p.username+" "+p.phone).toLowerCase().includes(query.toLowerCase())),[clients,query]);
  const activeConversation=selected;
  return <section className="content support-hub">
    <div className="support-heading"><div><small>GESTIÓN INTERNA</small><h2>Centro <em>SecuroServ</em></h2><p className="muted">Conversaciones privadas, miembros y expedientes de clientes.</p></div><span className="live-pill"><i/> EN VIVO</span></div>
    <div className="support-tabs">
      {(isManager?[["inbox","Bandeja de entrada",MessageCircle],["members","Miembros",Users],["clients","Clientes",Contact]]:[["messages","Mi atención",MessageCircle]]).map(([key,label,Icon])=><button key={key} className={tab===key?"selected":""} onClick={()=>setTab(key)}><Icon size={16}/>{label}</button>)}
    </div>
    {error&&<div className="support-alert">{error}</div>}{notice&&<div className="support-success">{notice}</div>}
    {tab==="inbox"&&isManager&&<div className="support-layout">
      <aside className="support-list"><div className="support-search"><Search size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar cliente o agente"/></div>
        {filteredConversations.length?filteredConversations.map(c=><button key={c.id} className={"support-conversation "+(selected?.id===c.id?"active":"")} onClick={()=>setSelected(c)}><span className="support-avatar">{c.owner_name?.slice(0,1)||"?"}</span><span className="support-conversation-info"><b>{c.owner_name}</b><small>{roleLabel(c.owner_role)} · {c.subject}</small><small>{dateLabel(c.last_message_at)}</small></span><span className="conversation-state">{c.status==="open"?"Abierto":"Cerrado"}</span></button>):<p className="muted support-empty">Todavía no hay conversaciones.</p>}
      </aside>
      <div className="support-thread">{activeConversation?<><div className="thread-heading"><div className="support-avatar large">{activeConversation.owner_name?.slice(0,1)||"?"}</div><div><b>{activeConversation.owner_name}</b><small>{roleLabel(activeConversation.owner_role)} · {activeConversation.subject}</small></div><span className="conversation-state">{activeConversation.status==="open"?"En atención":"Cerrado"}</span></div><div className="thread-messages">{messages.map(m=><article key={m.id} className={"thread-message "+(m.sender_id===session.user.id?"mine":"")}><small>{m.sender_name} · {dateLabel(m.created_at)}</small><p>{m.body}</p></article>)}{!messages.length&&<p className="muted">Selecciona una conversación o espera el primer mensaje.</p>}</div><form className="thread-compose" onSubmit={sendMessage}><input value={draft} onChange={e=>setDraft(e.target.value)} placeholder="Responder a esta persona..." disabled={activeConversation.status!=="open"}/><button className="red" disabled={activeConversation.status!=="open"||!draft.trim()}><Send size={16}/> Enviar</button></form></>:<div className="thread-placeholder"><MessageCircle size={32}/><p>Selecciona una conversación para atenderla.</p></div>}</div>
    </div>}
    {tab==="messages"&&!isManager&&<div className="support-self">
      <div className="thread-heading"><div className="support-avatar large">{profile?.full_name?.slice(0,1)||"?"}</div><div><b>{profile?.full_name}</b><small>{roleLabel(profile?.role)} · Conversación privada con Dirección</small></div><span className="conversation-state">Privado</span></div>
      <div className="thread-messages self-messages">{messages.map(m=><article key={m.id} className={"thread-message "+(m.sender_id===session.user.id?"mine":"")}><small>{m.sender_name} · {dateLabel(m.created_at)}</small><p>{m.body}</p></article>)}{!messages.length&&<p className="muted">Escribe aquí para comunicarte directamente con Dirección.</p>}</div>
      <form className="thread-compose" onSubmit={sendMessage}><input value={draft} onChange={e=>setDraft(e.target.value)} placeholder="Escribe tu mensaje..."/><button className="red" disabled={!draft.trim()}><Send size={16}/> Enviar</button></form>
    </div>}
    {tab==="members"&&isManager&&<div className="directory-grid">{filteredMembers.map(p=><article className="directory-card" key={p.id}><div className="directory-person"><img src={p.photo_url||"/avatar-placeholder.svg"} onError={e=>{e.currentTarget.src="/avatar-placeholder.svg"}} alt=""/><div><b>{p.full_name}</b><small>@{p.username}</small><span className={"member-status "+p.status}>{p.status==="approved"?"Activo":p.status==="pending"?"Pendiente":p.status==="suspended"?"Suspendido":"Inactivo"}</span></div></div><div className="directory-meta"><span><ShieldCheck size={14}/>{p.rank||roleLabel(p.role)}</span><span><UserRound size={14}/>{roleLabel(p.role)}</span><span><Clock3 size={14}/>{dateLabel(p.created_at)}</span>{p.phone&&<span>{p.phone}</span>}{p.discord&&<span>Discord: {p.discord}</span>}</div></article>)}</div>}
    {tab==="clients"&&isManager&&<div className="client-directory"><div className="support-search"><Search size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar cliente"/></div><div className="client-layout"><aside className="client-list">{filteredClients.map(c=><button key={c.id} className={clientDetails?.id===c.id?"active":""} onClick={()=>chooseClient(c)}><span className="support-avatar">{c.full_name?.slice(0,1)||"?"}</span><span><b>{c.full_name}</b><small>@{c.username} · {c.phone||"Sin teléfono"}</small></span></button>)}</aside><div className="client-record">{clientDetails?<><div className="thread-heading"><img className="client-photo" src={clientDetails.photo_url||"/avatar-placeholder.svg"} onError={e=>{e.currentTarget.src="/avatar-placeholder.svg"}} alt=""/><div><b>{clientDetails.full_name}</b><small>@{clientDetails.username} · {clientDetails.contact_email||"Sin correo"}</small></div></div><h3>Historial de servicios</h3>{history.length?history.map(a=><article className="history-card" key={a.id}><b>{new Date(a.date+"T00:00:00").toLocaleDateString("es-PA")} · {a.start_time?.slice(0,5)}–{a.end_time?.slice(0,5)}</b><span className={"appointment-status "+a.status}>{({pending:"Pendiente",confirmed:"Confirmado",completed:"Completado",rejected:"Rechazado",cancelled:"Cancelado"}[a.status]||a.status)}</span><p>{a.details||"Sin detalles adicionales"}</p></article>):<p className="muted">Este cliente todavía no tiene servicios registrados.</p>}<h3>Reseñas</h3>{reviews.length?reviews.map(r=><article className="review-card" key={r.id}><span className="review-stars">{"★".repeat(r.rating)}{"☆".repeat(5-r.rating)}</span><p>{r.comment||"Sin comentario"}</p><small>{dateLabel(r.created_at)}</small></article>):<p className="muted">Este cliente todavía no tiene reseñas registradas.</p>}</>:<div className="thread-placeholder"><Contact size={30}/><p>Selecciona un cliente para consultar su expediente.</p></div>}</div></div></div>}
  </section>;
}
