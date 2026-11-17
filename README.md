# SecuroServ

Portal público y sistema interno para SecuroServ — Private Security Corporation (GTA RP).

## Requisitos
- Node.js 20+
- Proyecto Supabase

## Desarrollo local
```bash
npm install
cp .env.example .env
npm run dev
```

Completa `.env` con la URL y la clave publicable de Supabase.

## Despliegue en Render

Este repositorio está preparado para ejecutarse como **Web Service** (Node.js), no como Static Site.

- Runtime: Node
- Build command: `npm install && npm run build`
- Start command: `npm start`
- Health check: `/api/health`
- Puerto: Render lo proporciona mediante la variable `PORT`.

El servidor Node sirve la aplicación compilada de Vite y expone el endpoint de salud. El archivo `render.yaml` contiene esta configuración para crear el servicio desde un Blueprint.

**Importante:** subir estos cambios a GitHub no convierte por sí solo el servicio Static Site existente. En Render habrá que crear el Web Service desde este repositorio (o cambiar el servicio desde el panel si Render ofrece esa opción). No elimines el Static Site anterior hasta comprobar que el Web Service funciona.

## Supabase

Variables públicas del frontend:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

No publiques nunca `service_role`, claves JWT ni contraseñas de base de datos.

## Funciones existentes
- Registro y acceso de cuentas.
- Perfil editable con correo, Discord, Discord ID y foto por URL.
- IBAN editable únicamente para perfiles de agente.
- Gestión de roles y etiquetas de negocios.
- Servicios con estados e historial.
- Chat individual por servicio con imágenes.
- Calendario público y solicitud de servicios.

## Estado de autenticación

La autenticación actual del frontend todavía usa Supabase Auth y la conversión interna de usuario a correo sintético. La migración solicitada a usuario y contraseña sin correo **todavía no está aplicada**. Antes de activarla hay que preparar el backend y migrar el esquema de cuentas con cuidado para conservar los perfiles y las relaciones existentes.


## Primer administrador y registro

El primer registro se protege desde el servidor de Render. Antes de habilitarlo:

1. Ejecuta el contenido de `supabase/initial-admin.sql` en Supabase → SQL Editor.
2. En Render → Web Service → Environment agrega:
   - `SUPABASE_URL`: URL del proyecto Supabase.
   - `SUPABASE_SERVICE_ROLE_KEY`: clave secreta de servidor de Supabase (nunca publicarla ni ponerla en GitHub).
   - `INITIAL_ADMIN_KEY`: clave privada que Dirección entregará únicamente a la primera persona que registre la cuenta.
3. Conserva también las variables públicas `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` para compilar el frontend.
4. Guarda los cambios y vuelve a desplegar.

La API valida la clave inicial en el servidor y la base de datos permite reclamar el cargo una sola vez. La primera cuenta se convierte en `director` aprobado; los registros siguientes nacen como clientes. No se solicita correo al usuario ni se requiere confirmación por correo: el correo técnico interno se genera a partir del nombre de usuario.

No compartas `SUPABASE_SERVICE_ROLE_KEY` ni `INITIAL_ADMIN_KEY` por chat, capturas o repositorios.
