import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const root = resolve(fileURLToPath(new URL("./dist/", import.meta.url)));
const port = Number(process.env.PORT || 3000);
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8"
};

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const initialAdminKey = process.env.INITIAL_ADMIN_KEY;
const adminClient = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// El chat comunitario es efímero: elimina cada mensaje al cumplir una hora.
if (adminClient) {
  let cleaningChat = false;
  const cleanExpiredCommunityMessages = async () => {
    if (cleaningChat) return;
    cleaningChat = true;
    try {
      const { error } = await adminClient.from("chat_messages").delete().lte("expires_at", new Date().toISOString());
      if (error) console.error("No se pudieron limpiar mensajes vencidos del chat:", error.message);
    } catch (error) {
      console.error("Error limpiando mensajes vencidos del chat:", error?.message || error);
    } finally {
      cleaningChat = false;
    }
  };
  cleanExpiredCommunityMessages();
  setInterval(cleanExpiredCommunityMessages, 5000);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}
function safeKeyMatch(provided, expected) {
  if (typeof provided !== "string" || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20000) throw new Error("La solicitud es demasiado grande.");
  }
  return JSON.parse(raw || "{}");
}
async function handleApi(req, res, url) {
  if (url.pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, service: "securoserv" });
    return true;
  }
  if (url.pathname === "/api/registration-status" && req.method === "GET") {
    if (!adminClient) {
      sendJson(res, 503, { error: "El servidor todavía no está configurado para registrar cuentas." });
      return true;
    }
    const { data, error } = await adminClient.from("securoserv_bootstrap").select("admin_claimed").eq("id", 1).maybeSingle();
    if (error || !data) {
      sendJson(res, 503, { error: "Falta aplicar la configuración inicial de SecuroServ en Supabase." });
      return true;
    }
    sendJson(res, 200, { initialAdminAvailable: !data.admin_claimed });
    return true;
  }
  if (url.pathname === "/api/register" && req.method === "POST") {
    if (!adminClient) {
      sendJson(res, 503, { error: "El servidor todavía no está configurado para registrar cuentas." });
      return true;
    }
    let body;
    try { body = await readJson(req); }
    catch (error) { sendJson(res, 400, { error: error.message || "Solicitud inválida." }); return true; }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const characterId = typeof body.characterId === "string" ? body.characterId.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const phone = typeof body.phone === "string" ? body.phone.replace(/\D/g, "") : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (name.length < 2 || name.length > 100 || characterId.length < 1 || characterId.length > 40 || !/^[a-z0-9_.-]{3,30}$/.test(username) || phone.length < 5 || phone.length > 20 || password.length < 8 || password.length > 128) {
      sendJson(res, 400, { error: "Revisa el nombre, usuario, teléfono y contraseña. La contraseña debe tener al menos 8 caracteres." });
      return true;
    }

    const { data: bootstrap, error: bootstrapError } = await adminClient.from("securoserv_bootstrap").select("admin_claimed").eq("id", 1).maybeSingle();
    if (bootstrapError || !bootstrap) {
      sendJson(res, 503, { error: "Falta aplicar la configuración inicial de SecuroServ en Supabase." });
      return true;
    }
    const email = username + "@users.securoserv.com";
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { full_name: name, character_id: characterId, username, phone }
    });
    if (createError || !created.user) {
      sendJson(res, 400, { error: createError?.message || "No se pudo crear la cuenta." });
      return true;
    }

    sendJson(res, 201, { ok: true, isInitialAdmin: false });
    return true;
  }
  if (url.pathname === "/api/my-service-rooms" && req.method === "GET") {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!adminClient || !token) { sendJson(res, 401, { error: "Inicia sesión para consultar tus servicios." }); return true; }
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !authData?.user) { sendJson(res, 401, { error: "Tu sesión no es válida." }); return true; }
    const { data: appointments, error: appointmentError } = await adminClient.from("appointments").select("service_id,status").eq("customer_user_id", authData.user.id).in("status", ["confirmed", "completed"]).not("service_id", "is", null);
    if (appointmentError) { sendJson(res, 500, { error: "No se pudieron consultar tus solicitudes: " + appointmentError.message }); return true; }
    const ids = [...new Set((appointments || []).map(row => row.service_id).filter(Boolean))];
    if (!ids.length) { sendJson(res, 200, { services: [] }); return true; }
    const { data: services, error: serviceError } = await adminClient.from("services").select("*").in("id", ids).order("created_at", { ascending: false });
    if (serviceError) { sendJson(res, 500, { error: "No se pudieron cargar tus salas: " + serviceError.message }); return true; }
    sendJson(res, 200, { services: services || [] }); return true;
  }
  if (url.pathname === "/api/customer-service-chat" && (req.method === "GET" || req.method === "POST")) {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!adminClient || !token) { sendJson(res, 401, { error: "Inicia sesión para abrir esta sala." }); return true; }
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !authData?.user) { sendJson(res, 401, { error: "Tu sesión no es válida." }); return true; }
    let body = {};
    if (req.method === "POST") { try { body = await readJson(req); } catch (error) { sendJson(res, 400, { error: error.message || "Solicitud inválida." }); return true; } }
    const serviceId = req.method === "GET" ? url.searchParams.get("serviceId") : body.serviceId;
    if (typeof serviceId !== "string" || !/^[0-9a-f-]{36}$/i.test(serviceId)) { sendJson(res, 400, { error: "Sala de servicio no válida." }); return true; }
    const { data: appointment, error: ownershipError } = await adminClient.from("appointments").select("id,status").eq("customer_user_id", authData.user.id).eq("service_id", serviceId).in("status", ["confirmed", "completed"]).maybeSingle();
    if (ownershipError || !appointment) { sendJson(res, 403, { error: "Esta sala no pertenece a tu cuenta o no ha sido aceptada." }); return true; }
    if (req.method === "GET") {
      const [{ data: messages, error: messagesError }, { data: events, error: eventsError }] = await Promise.all([
        adminClient.from("service_messages").select("*").eq("service_id", serviceId).order("created_at", { ascending: true }),
        adminClient.from("service_events").select("*").eq("service_id", serviceId).order("created_at", { ascending: true })
      ]);
      if (messagesError || eventsError) { sendJson(res, 500, { error: "No se pudo cargar el chat de la sala." }); return true; }
      sendJson(res, 200, { messages: messages || [], events: events || [] }); return true;
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > 4000) { sendJson(res, 400, { error: "Escribe un mensaje de hasta 4000 caracteres." }); return true; }
    if (appointment.status !== "confirmed") { sendJson(res, 409, { error: "El servicio ya finalizó y el chat está cerrado." }); return true; }
    const { data: service, error: serviceError } = await adminClient.from("services").select("status").eq("id", serviceId).maybeSingle();
    if (serviceError || !service || service.status === "completed") { sendJson(res, 409, { error: "Este servicio ya finalizó y no admite mensajes." }); return true; }
    const { data: profile } = await adminClient.from("profiles").select("full_name").eq("id", authData.user.id).maybeSingle();
    const { data: saved, error: insertError } = await adminClient.from("service_messages").insert({ service_id: serviceId, sender_id: authData.user.id, sender_name: profile?.full_name || "Cliente", body: message }).select("*").single();
    if (insertError) { sendJson(res, 500, { error: "No se pudo enviar el mensaje: " + insertError.message }); return true; }
    sendJson(res, 201, { message: saved }); return true;
  }
  if (url.pathname === "/api/my-profile" && req.method === "POST") {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!adminClient || !token) { sendJson(res, 401, { error: "Inicia sesión para consultar tu perfil." }); return true; }
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !authData?.user) { sendJson(res, 401, { error: "Tu sesión no es válida." }); return true; }
    const { data: profile, error } = await adminClient.from("profiles").select("*").eq("id", authData.user.id).maybeSingle();
    if (error) { sendJson(res, 500, { error: "No se pudo consultar tu perfil: " + error.message }); return true; }
    if (!profile) { sendJson(res, 404, { error: "Tu perfil todavía no existe." }); return true; }
    sendJson(res, 200, { profile });
    return true;
  }
  if (url.pathname === "/api/update-profile" && req.method === "POST") {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!adminClient || !token) { sendJson(res, 401, { error: "Inicia sesión para actualizar tu perfil." }); return true; }
    let body;
    try { body = await readJson(req); }
    catch (error) { sendJson(res, 400, { error: error.message || "Solicitud inválida." }); return true; }
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !authData?.user) { sendJson(res, 401, { error: "Tu sesión no es válida." }); return true; }
    const user = authData.user;
    const { data: current, error: currentError } = await adminClient.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (currentError || !current) { sendJson(res, 500, { error: "No se pudo consultar tu perfil." }); return true; }
    const fullName = typeof body.full_name === "string" ? body.full_name.trim() : current.full_name;
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : current.username;
    if (fullName.length < 2 || fullName.length > 100 || !/^[a-z0-9_.-]{3,30}$/.test(username)) {
      sendJson(res, 400, { error: "El nombre debe tener entre 2 y 100 caracteres y el usuario entre 3 y 30 (letras, números, punto, guion o guion bajo)." }); return true;
    }
    const usernameChanged = username !== current.username;
    if (usernameChanged) {
      const changedAt = current.username_changed_at ? new Date(current.username_changed_at).getTime() : 0;
      const nextAt = changedAt ? changedAt + 30 * 24 * 60 * 60 * 1000 : 0;
      if (nextAt && Date.now() < nextAt) {
        sendJson(res, 429, { error: "Solo puedes cambiar tu usuario una vez cada 30 días.", nextUsernameChangeAt: new Date(nextAt).toISOString() }); return true;
      }
      const { data: duplicate, error: duplicateError } = await adminClient.from("profiles").select("id").eq("username", username).neq("id", user.id).maybeSingle();
      if (duplicateError) { sendJson(res, 500, { error: "No se pudo verificar la disponibilidad del usuario." }); return true; }
      if (duplicate) { sendJson(res, 409, { error: "Ese nombre de usuario ya está en uso." }); return true; }
    }
    const age = body.age === "" || body.age == null ? current.age : Number(body.age);
    if (age != null && (!Number.isInteger(age) || age < 1 || age > 120)) {
      sendJson(res, 400, { error: "La edad debe ser un número entre 1 y 120." }); return true;
    }
    const oldEmail = user.email;
    const oldMetadata = user.user_metadata || {};
    const newEmail = username + "@users.securoserv.com";
    if (usernameChanged) {
      const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(user.id, {
        email: newEmail, email_confirm: true,
        user_metadata: { ...oldMetadata, full_name: fullName, username }
      });
      if (authUpdateError) { sendJson(res, 400, { error: "No se pudo actualizar el usuario de acceso: " + authUpdateError.message }); return true; }
    } else if (oldMetadata.full_name !== fullName) {
      const { error: metadataError } = await adminClient.auth.admin.updateUserById(user.id, {
        user_metadata: { ...oldMetadata, full_name: fullName, username }
      });
      if (metadataError) { sendJson(res, 400, { error: "No se pudo actualizar el nombre de la cuenta." }); return true; }
    }
    const update = {
      full_name: fullName, character_id: typeof body.character_id === "string" ? body.character_id.trim() || null : current.character_id, username,
      age,
      phone: typeof body.phone === "string" ? body.phone.replace(/\D/g, "") || null : current.phone,
      contact_email: typeof body.contact_email === "string" ? body.contact_email.trim() || null : current.contact_email,
      discord: typeof body.discord === "string" ? body.discord.trim() || null : current.discord,
      discord_id: typeof body.discord_id === "string" ? body.discord_id.trim() || null : current.discord_id,
      photo_url: typeof body.photo_url === "string" ? body.photo_url.trim() || null : current.photo_url,
      iban: current.role === "agent" && typeof body.iban === "string" ? body.iban.trim() || null : current.iban
    };
    const { data: saved, error: saveError } = await adminClient.from("profiles").update(update).eq("id", user.id).select("*").single();
    if (saveError) {
      if (usernameChanged) await adminClient.auth.admin.updateUserById(user.id, { email: oldEmail, email_confirm: true, user_metadata: oldMetadata });
      sendJson(res, 500, { error: "No se pudieron guardar los cambios del perfil: " + saveError.message }); return true;
    }
    sendJson(res, 200, { ok: true, profile: saved });
    return true;
  }
  if (url.pathname === "/api/ensure-customer-account" && req.method === "POST") {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!adminClient || !token) { sendJson(res, 401, { error: "Inicia sesión para continuar." }); return true; }
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !authData?.user) { sendJson(res, 401, { error: "Tu sesión no es válida." }); return true; }

    const user = authData.user;
    const metadata = user.user_metadata || {};
    const { data: existingProfile, error: profileError } = await adminClient
      .from("profiles").select("id,role,status").eq("id", user.id).maybeSingle();
    if (profileError) {
      sendJson(res, 500, { error: "No se pudo consultar tu perfil: " + profileError.message });
      return true;
    }

    if (!existingProfile) {
      const fullName = typeof metadata.full_name === "string" && metadata.full_name.trim()
        ? metadata.full_name.trim() : "Usuario";
      const username = typeof metadata.username === "string" && metadata.username.trim()
        ? metadata.username.trim().toLowerCase() : "user_" + user.id.slice(0, 8);
      const phone = typeof metadata.phone === "string" ? metadata.phone.replace(/\D/g, "") : null;
      const characterId = typeof metadata.character_id === "string" ? metadata.character_id.trim() : null;
      const { error: insertError } = await adminClient.from("profiles").insert({
        id: user.id, full_name: fullName, character_id: characterId, username, phone: phone || null,
        role: "customer", status: "approved", rank: "Cliente"
      });
      if (insertError) {
        sendJson(res, 500, { error: "No se pudo crear tu perfil de Cliente: " + insertError.message });
        return true;
      }
    } else if (existingProfile.role === "customer" && existingProfile.status !== "approved") {
      const { error: updateError } = await adminClient.from("profiles")
        .update({ status: "approved", rank: "Cliente" })
        .eq("id", user.id).eq("role", "customer");
      if (updateError) {
        sendJson(res, 500, { error: "No se pudo activar tu cuenta de Cliente: " + updateError.message });
        return true;
      }
    }

    sendJson(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/claim-initial-admin" && req.method === "POST") {
    if (!adminClient || !initialAdminKey) {
      sendJson(res, 503, { error: "La activación de Dirección no está configurada en el servidor." });
      return true;
    }
    let body;
    try { body = await readJson(req); }
    catch (error) { sendJson(res, 400, { error: error.message || "Solicitud inválida." }); return true; }
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) { sendJson(res, 401, { error: "Inicia sesión antes de solicitar la activación." }); return true; }
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !authData?.user) { sendJson(res, 401, { error: "Tu sesión no es válida. Inicia sesión nuevamente." }); return true; }

    // La activación es idempotente: si esta cuenta ya es Dirección, no se vuelve a consumir la clave.
    const { data: currentProfile, error: currentProfileError } = await adminClient
      .from("profiles").select("id,role,status").eq("id", authData.user.id).maybeSingle();
    if (currentProfileError) {
      sendJson(res, 500, { error: "No se pudo consultar el perfil: " + currentProfileError.message });
      return true;
    }
    if (currentProfile?.role === "director" && currentProfile.status === "approved") {
      sendJson(res, 200, { ok: true, role: "director", alreadyActivated: true });
      return true;
    }
    if (!safeKeyMatch(body.key, initialAdminKey)) { sendJson(res, 403, { error: "La clave de activación no es válida." }); return true; }
    const { data: bootstrap, error: bootstrapError } = await adminClient.from("securoserv_bootstrap").select("admin_claimed").eq("id", 1).maybeSingle();
    if (bootstrapError || !bootstrap) { sendJson(res, 503, { error: "Falta aplicar la configuración inicial de SecuroServ en Supabase." }); return true; }
    if (bootstrap.admin_claimed) { sendJson(res, 409, { error: "La activación inicial ya fue utilizada. Tu cuenta permanece como Cliente." }); return true; }
    let { data: profile, error: profileError } = await adminClient.from("profiles").select("id,role,status").eq("id", authData.user.id).maybeSingle();
    if (profileError) {
      sendJson(res, 500, { error: "No se pudo consultar el perfil: " + profileError.message });
      return true;
    }

    // Si el trigger de Supabase no creó el perfil al registrar la cuenta,
    // lo creamos desde los metadatos verificados del usuario autenticado.
    if (!profile) {
      const metadata = authData.user.user_metadata || {};
      const fullName = typeof metadata.full_name === "string" && metadata.full_name.trim()
        ? metadata.full_name.trim() : "Director SecuroServ";
      const username = typeof metadata.username === "string" && metadata.username.trim()
        ? metadata.username.trim().toLowerCase() : "director_" + authData.user.id.slice(0, 8);
      const phone = typeof metadata.phone === "string" ? metadata.phone.replace(/\\D/g, "") : null;
      const { error: insertError } = await adminClient.from("profiles").insert({
        id: authData.user.id, full_name: fullName, username, phone: phone || null,
        role: "customer", status: "approved", rank: "Cliente"
      });
      if (insertError && insertError.code !== "23505") {
        sendJson(res, 500, { error: "No se pudo crear el perfil de tu cuenta: " + insertError.message });
        return true;
      }
      const refreshed = await adminClient.from("profiles").select("id,role,status").eq("id", authData.user.id).maybeSingle();
      profile = refreshed.data;
      profileError = refreshed.error;
      if (profileError || !profile) {
        sendJson(res, 500, { error: "El perfil sigue sin estar disponible después de intentar crearlo." });
        return true;
      }
    }
    const { data: claimed, error: claimError } = await adminClient.rpc("claim_securoserv_initial_admin", { p_user_id: authData.user.id });
    if (claimError) { sendJson(res, 500, { error: "No se pudo activar Dirección. Revisa la configuración de Supabase." }); return true; }
    if (claimed !== true) { sendJson(res, 409, { error: "La activación inicial ya fue utilizada. Tu cuenta permanece como Cliente." }); return true; }
    sendJson(res, 200, { ok: true, role: "director" });
    return true;
  }
  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "Ruta API no encontrada." });
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (await handleApi(req, res, url)) return;
  } catch (error) {
    console.error("API error:", error?.message || error);
    sendJson(res, 500, { error: "Error interno del servidor." });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }

  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); res.end("Bad request"); return; }

  let filePath = resolve(root, "." + pathname);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = resolve(filePath, "index.html");
    const body = await readFile(filePath);
    const isAsset = pathname.startsWith("/assets/");
    res.writeHead(200, {
      "content-type": mime[extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache"
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    try {
      const body = await readFile(resolve(root, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("SecuroServ is starting. Build the frontend with npm run build.");
    }
  }
});
server.listen(port, "0.0.0.0", () => console.log(`SecuroServ Web Service listening on port ${port}`));
