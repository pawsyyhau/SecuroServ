# SecuroServ

Portal público y sistema interno para SecuroServ — Private Security Corporation (GTA RP).

## Requisitos
- Node.js 20+
- Proyecto Supabase

## Instalación
```bash
npm install
cp .env.example .env
npm run dev
```
Completa `.env` con la URL y la clave anon/public de Supabase.

## Base de datos
Ejecuta `supabase/schema.sql` en Supabase SQL Editor.

Después de crear la primera cuenta, asigna manualmente a ese usuario `role='director'` y `status='approved'` en `public.profiles`. Nunca coloques la clave `service_role` en el navegador.

## Funciones iniciales
- Portal público y panel de acceso de agentes con aprobación.
- Calendario público para consultar horarios ocupados.
- Formulario de solicitud de servicio.
- Indicadores de agentes aprobados y servicios confirmados.
- Base SQL para perfiles, agenda, fichajes, clientes, reseñas, quejas y chat.

El chat requiere activar Supabase Realtime y completar el flujo de atención en vivo. Antes de producción, endurecer RLS, validación de solapamientos y controles anti-spam.