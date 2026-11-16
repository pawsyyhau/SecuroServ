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

## Agenda y privacidad
La página pública consulta únicamente `availability_slots` (fecha y hora). Los datos identificativos de clientes permanecen en `appointments`, que solo puede leer personal aprobado. El trigger mantiene los intervalos públicos sincronizados con solicitudes pendientes y confirmadas. La base incluye una restricción para impedir reservas superpuestas.

## Estado
Esta es la primera entrega del portal y la estructura de datos. El panel completo de agentes, fichajes, clientes, reseñas, quejas, gestión de reservas y chat realmente en vivo aún requiere desarrollo adicional y configuración de Supabase.