import React,{useCallback,useEffect,useState} from "react";
import {supabase} from "./supabase";
import {ArrowLeft,Upload,ShieldCheck,UserRound,ClipboardList,Plus,Trash2,Check,X,Save,Clock3,Image as ImageIcon} from "lucide-react";
import "./recruitment.css";

const blankForm={email:"",phone:"",age:"",iban:""};
const defaultQuestions=[
 "¿Por qué quieres formar parte de SecuroServ?",
 "¿Qué significa para ti la responsabilidad dentro de una corporación de seguridad?",
 "¿Cómo actuarías ante un cliente molesto o una situación tensa?",
 "¿Qué harías si un compañero incumple una instrucción durante un servicio?",
 "¿Qué disponibilidad tienes para trabajar y participar en servicios?"
];
const roleLabel=r=>({customer:"Cliente",agent:"Agente",commander:"Comandante",admin:"Administrador",director:"Dirección"}[r]||r);

export default function RecruitmentHub({session,profile,isManager,onNotice,onBack}){
 const [settings,setSettings]=useState({title:"Quiero trabajar con ustedes",body:"En SecuroServ buscamos personas responsables, disciplinadas y comprometidas. Completa tu postulación para que Dirección pueda evaluarla."});
 const [questions,setQuestions]=useState([]),[applications,setApplications]=useState([]),[members,setMembers]=useState([]);
 const [form,setForm]=useState(blankForm),[answers,setAnswers]=useState({}),[photo,setPhoto]=useState(null),[photoPreview,setPhotoPreview]=useState("");
 const [busy,setBusy]=useState(false),[editingText,setEditingText]=useState(false),[settingsDraft,setSettingsDraft]=useState(settings);
 const [questionDraft,setQuestionDraft]=useState(""),[editingQuestion,setEditingQuestion]=useState("");
 const [selected,setSelected]=useState(null),[tab,setTab]=useState("apply");
 const notice=message=>onNotice?.(message);
 const load=useCallback(async()=>{
  const [s,q]=await Promise.all([
   supabase.from("recruitment_settings").select("*").eq("id",1).maybeSingle(),
   supabase.from("recruitment_questions").select("*").eq("is_active",true).order("sort_order")
  ]);
  if(s.data){setSettings(s.data);setSettingsDraft(s.data)}
  if(q.data?.length){setQuestions(q.data)}else if(!q.error){setQuestions(defaultQuestions.map((question,i)=>({id:"default-"+i,question,sort_order:i+1,is_active:true})))}
  if(isManager){
   const [a,m]=await Promise.all([
    supabase.from("recruitment_applications").select("*,applicant:profiles!recruitment_applications_user_id_fkey(full_name,username,rank)").order("created_at",{ascending:false}),
    supabase.from("profiles").select("id,full_name,username,age,phone,contact_email,iban,photo_url,rank,role,status,created_at").in("role",["agent","commander","admin","director"]).order("full_name")
   ]);
   if(a.error)notice("Postulaciones: "+a.error.message);else setApplications(a.data||[]);
   if(m.error)notice("Personal: "+m.error.message);else setMembers(m.data||[]);
  }
 },[isManager,notice]);
 useEffect(()=>{load();const ch=supabase.channel("recruitment-live").on("postgres_changes",{event:"*",schema:"public",table:"recruitment_questions"},load).on("postgres_changes",{event:"*",schema:"public",table:"recruitment_applications"},load).on("postgres_changes",{event:"*",schema:"public",table:"recruitment_settings"},load).on("postgres_changes",{event:"*",schema:"public",table:"profiles"},load).subscribe();return()=>supabase.removeChannel(ch)},[load]);
 useEffect(()=>{if(!photo){setPhotoPreview("");return}const url=URL.createObjectURL(photo);setPhotoPreview(url);return()=>URL.revokeObjectURL(url)},[photo]);
 const setField=(key,value)=>setForm(v=>({...v,[key]:value}));
 async function submitApplication(e){
  e.preventDefault();if(!session?.user?.id){notice("Inicia sesión para presentar tu postulación.");return}
  if(!photo){notice("Selecciona una foto de tu personaje.");return}
  if(!photo.type.startsWith("image/")||photo.size>8*1024*1024){notice("La foto debe ser una imagen de máximo 8 MB.");return}
  if(Number(form.age)<18||Number(form.age)>99){notice("La edad debe estar entre 18 y 99 años.");return}
  if(!form.email.trim()||!form.phone.trim()||!form.iban.trim()){notice("Completa correo, celular e IBAN.");return}
  if(questions.some(q=>!String(answers[q.id]||"").trim())){notice("Responde todas las preguntas del formulario.");return}
  setBusy(true);
  const path=session.user.id+"/"+Date.now()+"-"+photo.name.replace(/[^a-zA-Z0-9._-]/g,"_");
  const upload=await supabase.storage.from("staff-photos").upload(path,photo,{upsert:true,contentType:photo.type});
  if(upload.error){setBusy(false);notice("No se pudo subir la foto: "+upload.error.message);return}
  const payload={user_id:session.user.id,roleplay_email:form.email.trim(),roleplay_phone:form.phone.trim(),age:Number(form.age),iban:form.iban.trim().toUpperCase(),character_photo_path:path,answers:Object.fromEntries(questions.map(q=>[q.id,{question:q.question,answer:String(answers[q.id]||"").trim()}])),status:"pending"};
  const {error}=await supabase.from("recruitment_applications").upsert(payload,{onConflict:"user_id"}).select().single();
  setBusy(false);
  if(error){notice("No se pudo enviar la postulación: "+error.message);return}
  setPhoto(null);setAnswers({});notice("Postulación enviada. Dirección revisará tu información.");
  setTab("status");await load();
 }
 async function saveSettings(e){e.preventDefault();const {error}=await supabase.from("recruitment_settings").upsert({id:1,title:settingsDraft.title,body:settingsDraft.body,updated_by:session.user.id},{onConflict:"id"});if(error)notice(error.message);else{setSettings(settingsDraft);setEditingText(false);notice("Información de reclutamiento actualizada en vivo.")}}
 async function addQuestion(e){e.preventDefault();if(!questionDraft.trim())return;const {error}=await supabase.from("recruitment_questions").insert({question:questionDraft.trim(),sort_order:questions.length+1,is_active:true,created_by:session.user.id});if(error)notice(error.message);else{setQuestionDraft("");notice("Pregunta añadida al formulario.")}}
 async function updateQuestion(q){const {error}=await supabase.from("recruitment_questions").update({question:q.question.trim()}).eq("id",q.id);if(error)notice(error.message);else{setEditingQuestion("");notice("Pregunta actualizada.")}}
 async function deleteQuestion(id){if(!window.confirm("¿Eliminar esta pregunta del formulario?"))return;const {error}=await supabase.from("recruitment_questions").delete().eq("id",id);if(error)notice(error.message);else notice("Pregunta eliminada.")}
 async function decide(app,accept){
  if(!isManager)return;
  setBusy(true);
  if(accept){
   const {data:photoData}=supabase.storage.from("staff-photos").getPublicUrl(app.character_photo_path);
   const {error:profileError}=await supabase.from("profiles").update({role:"agent",status:"approved",rank:"Agente Aprendiz",age:app.age,phone:app.roleplay_phone,contact_email:app.roleplay_email,iban:app.iban,photo_url:photoData.publicUrl}).eq("id",app.user_id);
   if(profileError){setBusy(false);notice("No se pudo activar el perfil: "+profileError.message);return}
  }
  const {error}=await supabase.from("recruitment_applications").update({status:accept?"accepted":"rejected",reviewed_by:session.user.id,reviewed_at:new Date().toISOString()}).eq("id",app.id);
  setBusy(false);if(error){notice(error.message);return}
  notice(accept?"Postulación aceptada. La persona ya aparece en el personal como Agente Aprendiz.":"Postulación rechazada.");setSelected(null);await load();
 }
 const pending=applications.filter(a=>a.status==="pending");
 const myApplication=applications.find(a=>a.user_id===session?.user?.id);
 const photoUrl=path=>supabase.storage.from("staff-photos").getPublicUrl(path).data.publicUrl;
 return <section className="content recruitment">
  <div className="recruitment-heading"><div><small>SECUROSERV · FAMILIA BUSTAMANTE</small><h2>{settings.title||"Quiero trabajar con ustedes"}</h2><p className="muted">{settings.body}</p></div><button className="outline" onClick={onBack}><ArrowLeft size={15}/> Volver</button></div>
  {isManager&&<div className="recruit-tabs">{[["apply","Vista del postulante"],["applications","Postulaciones"],["members","Personal"],["settings","Editar contenido"]].map(([v,l])=><button key={v} className={tab===v?"active":""} onClick={()=>setTab(v)}>{l}{v==="applications"&&pending.length>0?<b>{pending.length}</b>:null}</button>)}</div>}
  {!isManager&&myApplication&&tab==="apply"&&<div className="recruit-status"><Clock3 size={18}/><div><b>Ya tienes una postulación</b><span>Estado: {({pending:"En revisión",accepted:"Aceptada",rejected:"No aceptada"}[myApplication.status]||myApplication.status)}. Puedes consultar su estado aquí.</span></div><button className="outline" onClick={()=>setTab("status")}>Ver estado</button></div>}
  {(!isManager&&tab==="status")&&<div className="panel recruit-panel"><h3>Estado de mi postulación</h3><span className={"status "+(myApplication?.status||"pending")}>{({pending:"En revisión",accepted:"Aceptada",rejected:"No aceptada"}[myApplication?.status]||"Sin postulación")}</span><p className="muted">{myApplication?.status==="accepted"?"¡Felicidades! Ya formas parte del personal de SecuroServ.":myApplication?.status==="rejected"?"Tu postulación no fue aceptada en esta ocasión.":"Dirección todavía no ha tomado una decisión."}</p></div>}
  {(!isManager||tab==="apply")&&(!myApplication||myApplication.status==="rejected")&&<div className="recruit-layout"><div className="panel recruit-info"><span className="recruit-icon"><ShieldCheck/></span><small>PROCESO DE SELECCIÓN</small><h3>Una carrera basada en disciplina y confianza.</h3><p>Completa tus datos y responde el cuestionario. Tu solicitud llegará directamente a Dirección.</p><ul><li>Datos de tu personaje</li><li>Foto para tu identificación interna</li><li>Evaluación mediante preguntas</li><li>Revisión y aprobación por Dirección</li></ul></div>
   <form className="panel recruit-form" onSubmit={submitApplication}><div><small>01 / INFORMACIÓN DEL PERSONAJE</small><h3>Datos de postulación</h3><p className="muted">Tu nombre de personaje se toma de tu cuenta. No necesitas escribirlo otra vez.</p></div>
    <label>Correo electrónico del personaje<input type="email" required maxLength={160} value={form.email} onChange={e=>setField("email",e.target.value)} placeholder="correo dentro del rol"/></label>
    <label>Número celular del personaje<input required maxLength={40} value={form.phone} onChange={e=>setField("phone",e.target.value)} placeholder="Número de contacto dentro del rol"/></label>
    <div className="two"><label>Edad del personaje<input type="number" min="18" max="99" required value={form.age} onChange={e=>setField("age",e.target.value)}/></label><label>IBAN para depósitos<input required maxLength={80} value={form.iban} onChange={e=>setField("iban",e.target.value.replace(/[^a-zA-Z0-9]/g,"").toUpperCase())} placeholder="Cuenta bancaria del personaje"/></label></div>
    <label className="recruit-upload"><span><ImageIcon size={18}/> Foto del personaje</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>setPhoto(e.target.files?.[0]||null)}/><small>Selecciona una imagen desde tu dispositivo. Máximo 8 MB.</small></label>
    {photoPreview&&<img className="recruit-preview" src={photoPreview} alt="Vista previa del personaje"/>}
    <div className="recruit-questions"><small>02 / CUESTIONARIO</small><h3>Evaluación de ingreso</h3>{questions.map((q,i)=><label key={q.id}><span>{String(i+1).padStart(2,"0")} · {q.question}</span><textarea required rows="3" value={answers[q.id]||""} onChange={e=>setAnswers(v=>({...v,[q.id]:e.target.value}))} placeholder="Escribe tu respuesta..."/></label>)}</div>
    <button className="red full" disabled={busy||!session}>{busy?"Enviando postulación...":"Enviar postulación"}</button>
   </form>
  </div>}
  {!session&&<div className="recruit-login"><UserRound/><div><b>Inicia sesión para postularte</b><span>Tu cuenta ya contiene tu nombre de personaje. Accede para continuar con el formulario.</span></div><button className="red" onClick={()=>onNotice?.("Vuelve a Inicio de sesión desde la barra superior y luego abre Quiero trabajar con ustedes.")}>Necesito iniciar sesión</button></div>}
  {isManager&&tab==="applications"&&<div className="recruit-admin-grid">{applications.length===0?<div className="panel">Todavía no hay postulaciones.</div>:applications.map(a=><article className="panel recruit-app-card" key={a.id}><img src={photoUrl(a.character_photo_path)} alt="Personaje"/><div className="recruit-app-main"><span className={"status "+a.status}>{({pending:"Pendiente",accepted:"Aceptada",rejected:"Rechazada"}[a.status]||a.status)}</span><h3>{a.applicant?.full_name||a.applicant?.username||"Postulante"}</h3><p className="muted">@{a.applicant?.username||"usuario"} · {a.roleplay_email} · {a.roleplay_phone} · {a.age} años</p><p className="muted">IBAN: {a.iban}</p><button className="outline" onClick={()=>setSelected(selected?.id===a.id?null:a)}>Ver expediente</button></div>{a.status==="pending"&&<div className="recruit-decisions"><button className="red" disabled={busy} onClick={()=>decide(a,true)}><Check size={14}/> Aceptar</button><button className="outline" disabled={busy} onClick={()=>decide(a,false)}><X size={14}/> Rechazar</button></div>}{selected?.id===a.id&&<div className="recruit-answers"><h4>Respuestas del cuestionario</h4>{Object.values(a.answers||{}).map((v,i)=><div key={i}><b>{v.question}</b><p>{v.answer}</p></div>)}</div>}</article>)}</div>}
  {isManager&&tab==="members"&&<div className="recruit-member-grid">{members.map(m=><article className="panel recruit-member" key={m.id}><img src={m.photo_url||"/avatar-placeholder.svg"} alt="Identificación"/><div><small>{m.rank||roleLabel(m.role)}</small><h3>{m.full_name}</h3><p>@{m.username}</p><p>{m.age||"—"} años · {m.phone||"Sin teléfono"}</p><p>{m.contact_email||"Sin correo"}</p><p>IBAN: {m.iban||"No registrado"}</p></div></article>)}</div>}
  {isManager&&tab==="settings"&&<div className="recruit-layout recruit-settings"><div className="panel recruit-panel"><h3>Contenido público</h3><form onSubmit={saveSettings}><label>Título<input value={settingsDraft.title||""} onChange={e=>setSettingsDraft(v=>({...v,title:e.target.value}))}/></label><label>Texto e instrucciones<textarea rows="8" value={settingsDraft.body||""} onChange={e=>setSettingsDraft(v=>({...v,body:e.target.value}))}/></label><button className="red"><Save size={15}/> Publicar cambios</button></form></div><div className="panel recruit-panel"><h3>Formulario editable</h3><p className="muted">Agrega, modifica o elimina preguntas. Los cambios se reflejan en el formulario de nuevos postulantes.</p><form className="recruit-add-question" onSubmit={addQuestion}><input value={questionDraft} onChange={e=>setQuestionDraft(e.target.value)} placeholder="Escribe una nueva pregunta"/><button className="red"><Plus size={15}/></button></form>{questions.map(q=><div className="recruit-question-edit" key={q.id}>{editingQuestion===q.id?<><input value={q.question} onChange={e=>setQuestions(v=>v.map(x=>x.id===q.id?{...x,question:e.target.value}:x))}/><button className="outline" onClick={()=>updateQuestion(q)}><Save size={14}/></button></>:<span>{q.question}</span>}<button className="outline" onClick={()=>setEditingQuestion(editingQuestion===q.id?"":q.id)}>{editingQuestion===q.id?"Cancelar":"Editar"}</button><button className="outline" onClick={()=>deleteQuestion(q.id)}><Trash2 size={14}/></button></div>)}</div></div>}
  {isManager&&tab==="apply"&&<div className="panel recruit-panel"><h3>Vista previa del formulario</h3><p className="muted">Esta es la misma pantalla que verá una persona interesada en unirse a SecuroServ.</p></div>}
 </section>;
}
