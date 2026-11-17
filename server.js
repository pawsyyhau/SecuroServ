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
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const phone = typeof body.phone === "string" ? body.phone.replace(/\D/g, "") : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (name.length < 2 || name.length > 100 || !/^[a-z0-9_.-]{3,30}$/.test(username) || phone.length < 5 || phone.length > 20 || password.length < 8 || password.length > 128) {
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
      user_metadata: { full_name: name, username, phone }
    });
    if (createError || !created.user) {
      sendJson(res, 400, { error: createError?.message || "No se pudo crear la cuenta." });
      return true;
    }

    sendJson(res, 201, { ok: true, isInitialAdmin: false });
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
      const phone = typeof metadata.phone === "string" ? metadata.phone.replace(/\\D/g, "") : null;
      const { error: insertError } = await adminClient.from("profiles").insert({
        id: user.id, full_name: fullName, username, phone: phone || null,
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
    if (!safeKeyMatch(body.key, initialAdminKey)) { sendJson(res, 403, { error: "La clave de activación no es válida." }); return true; }
    const { data: bootstrap, error: bootstrapError } = await adminClient.from("securoserv_bootstrap").select("admin_claimed").eq("id", 1).maybeSingle();
    if (bootstrapError || !bootstrap) { sendJson(res, 503, { error: "Falta aplicar la configuración inicial de SecuroServ en Supabase." }); return true; }
    if (bootstrap.admin_claimed) { sendJson(res, 409, { error: "La activación inicial ya fue utilizada. Tu cuenta permanece como Cliente." }); return true; }
    const { data: profile, error: profileError } = await adminClient.from("profiles").select("role,status").eq("id", authData.user.id).maybeSingle();
    if (profileError || !profile || profile.role !== "customer") {
      sendJson(res, 403, { error: "Solo una cuenta de Cliente activa puede solicitar la activación inicial." });
      return true;
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
