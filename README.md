# SecuroServ

Portal público y sistema interno para SecuroServ — Private Security Corporation (GTA RP).

## Requisitos
- Node.js 20+
- Proyecto Supabase

## Instalación
\`\`\`bash
npm install
cp .env.example .env
npm run dev
\`\`\`
Completa \`.env\` con la URL y la clave publicable de Supabase.

## Configuración de Supabase
1. Ejecuta todo el archivo \`supabase/schema.sql\` en el SQL Editor.
2. En Authentication → Providers, activa **Phone** y configura un proveedor SMS.
3. En Authentication → URL Configuration, agrega el dominio publicado de Render.
4. Activa la confirmación por SMS y prueba el envío de códigos.
5. Después de crear tu primera cuenta, conviértela en directora desde SQL Editor:

\`\`\`sql
update public.profiles
set role = 'director', status = 'approved', rank = 'Dirección'
where phone = '+507TU_NUMERO';
\`\`\`

El registro solicita únicamente nombre completo, usuario, celular y contraseña. El número debe llevar prefijo internacional (por ejemplo, +507). El correo y otros datos se completan dentro del perfil. El IBAN solo se muestra para perfiles con rol de agente.

## Funciones incluidas
- Registro e inicio de sesión con celular y contraseña (requiere proveedor SMS de Supabase).
- Perfil editable con correo, Discord, Discord ID y foto por URL.
- IBAN editable únicamente por agentes.
- Gestión de cuentas: Dirección puede asignar roles de cliente, agente, comandante, administrador o director.
- Etiquetas de negocios creadas y asignadas por administradores.
- Creación de servicios con nombre, club y descripción.
- Estados programado, activo, pausado y finalizado.
- Pausar y reanudar servicios en fechas posteriores sin perder el historial.
- Historial automático de creación, inicio, pausa, reanudación y finalización.
- Sala de chat individual por servicio, con mensajes, emojis y fotografías.
- Fotografías guardadas en el bucket privado \`service-chat\`.
- Mensajes e historial en tiempo real mediante Supabase Realtime.
- Calendario público y solicitud de servicios.

## Seguridad
- No publiques la clave \`service_role\`; el frontend utiliza solamente la clave publicable.
- Las políticas RLS limitan la gestión de servicios y etiquetas a administradores aprobados.
- Las salas de servicio solo pueden consultarse por personal aprobado.
- El almacenamiento de imágenes es privado y las imágenes se sirven con enlaces temporales.
- La primera cuenta debe convertirse manualmente en directora antes de administrar el portal.

## Despliegue en Render
- Tipo: Static Site
- Build command: \`npm install && npm run build\`
- Publish directory: \`dist\`
- Variables:
  - \`VITE_SUPABASE_URL\`
  - \`VITE_SUPABASE_ANON_KEY\`

Cada commit a \`main\` inicia un nuevo despliegue en Render.
