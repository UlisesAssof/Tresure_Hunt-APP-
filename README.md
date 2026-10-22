# Búsqueda del tesoro — actualización de flujo

## Archivos
- `index.html`: formulario de creación de partidas y solicitud de ingreso a equipos.
- `app.js`: conecta el formulario con los RPC `crear_partida`, `crear_equipo` y `solicitar_unirse_equipo`.
- `config.js`: mantiene la configuración Supabase que ya estaba en los archivos entregados.
- `styles.css`: conserva los estilos y agrega el ajuste de los campos de selección.

## Requisitos de Supabase
Este paquete espera que ya existan estas funciones:
- `public.crear_partida(text, integer, boolean, boolean, integer, integer)` — la versión de seis parámetros que acabás de crear.
- `public.crear_equipo(text)`.
- `public.solicitar_unirse_equipo(text)`.
- `public.guardar_datos_participante(...)`.

No ejecutes SQL de eliminación ni recrees tablas. Si `crear_equipo` o `solicitar_unirse_equipo` devuelve un error, compartí el texto exacto para comprobar la firma real de la función.

## Instalación
1. Hacé una copia de seguridad de tus cuatro archivos actuales.
2. Extraé este ZIP en una carpeta nueva y reemplazá los cuatro archivos por estos.
3. Abrí `index.html` desde Live Server o un hosting HTTPS (no es recomendable abrirlo directamente como `file://`).
4. Iniciá sesión con una cuenta organizadora y probá crear un equipo.
5. Con una cuenta de jugador, probá enviar una solicitud con el código del equipo.
6. Probá crear una partida con duración y reglas configuradas.

La interfaz no implementa todavía la aprobación de solicitudes, el agregado de equipos a una partida ni la geolocalización. La validación definitiva de permisos sigue siendo responsabilidad de Supabase.


## Nueva pantalla de solicitudes
El panel del organizador incluye ahora `Solicitudes de equipos`, consulta integrantes con estado `solicitado` y llama a `resolver_solicitud_equipo(p_usuario_id, p_aceptar)` para aceptar/rechazar.

Requisito: las políticas RLS deben permitir al organizador consultar integrantes de sus propios equipos y la función SQL `resolver_solicitud_equipo` debe existir con esa firma. La consulta de relación asume que `integrantes_equipo.equipo_id` referencia `equipos.id`. Si Supabase devuelve un error de relación o permisos, copiá el mensaje exacto para adaptar la consulta al esquema real.


## Estado del equipo para el jugador
La pantalla de partidas ahora consulta `integrantes_equipo` al iniciar sesión y al entrar al menú:
- `sin_equipo` o sin `equipo_id`: muestra la opción para solicitar ingreso.
- `solicitado`: muestra que la solicitud está pendiente.
- `aceptado`: consulta `equipos`, muestra el nombre y el código del equipo y oculta la opción de volver a solicitar.
- Si encuentra una participación visible en `participantes_partida`, intenta mostrar también el nombre y estado de la partida.

No requiere SQL nuevo. La lectura está sujeta a las políticas RLS de Supabase. Si una consulta no está autorizada, la aplicación mostrará el error en la tarjeta de estado en lugar de asumir que el jugador no tiene equipo.


## Administración de partidas y equipos
El menú del organizador incluye la pantalla "Administrar partidas y equipos". Permite consultar las partidas propias, seleccionar una, agregar equipos propios activos mediante `agregar_equipo_partida(p_partida_id, p_equipo_id)` y solicitar el inicio mediante `iniciar_partida(p_partida_id)`. Las funciones RPC de Supabase validan los permisos y los requisitos de integrantes. Si una consulta falla por RLS, revisá las políticas SELECT para que el organizador pueda leer sus propias partidas, equipos y participantes.


## Terminar partidas
La pantalla de administración muestra el botón **Terminar partida** cuando la partida está `en_curso`. Al confirmarlo, llama a `public.finalizar_partida(p_partida_id)`, que verifica que la cuenta sea organizadora y dueña de la partida, cambia su estado a `finalizada` y registra la hora de finalización en el progreso de los equipos.

**Instalación requerida:** ejecutar una sola vez el archivo `finalizar_partida.sql` desde Supabase → SQL Editor. Después, reemplazar los archivos de la aplicación por los del ZIP y recargar la página. El botón solo aparece para partidas en curso; las partidas esperando no se pueden terminar con esta acción.


## Corrección: terminar o cancelar partidas
El botón ahora aparece en toda partida que no esté finalizada. Si está en curso dice “Terminar partida”; si todavía está esperando, dice “Cancelar partida”. La función SQL `finalizar_partida(uuid)` debe actualizarse ejecutando nuevamente el archivo `finalizar_partida.sql` en Supabase SQL Editor para aceptar ambos estados.


## Verificación al terminar una partida
La interfaz ahora consulta nuevamente `partidas.estado` después de llamar a `finalizar_partida`. Si Supabase no devuelve `finalizada`, mostrará un error visible. Ejecutá `finalizar_partida.sql` en el SQL Editor del mismo proyecto Supabase usado por `config.js`.


## Ocultar partidas finalizadas

La lista de administración filtra las partidas cuyo estado es `finalizada`, por lo que dejan de aparecer después de terminarlas. Sus registros y el progreso de los equipos se conservan en Supabase para no borrar resultados ni historial. No requiere ejecutar SQL adicional.

## Organizar y eliminar equipos

El menú del organizador incluye `Organizar equipos`, donde se listan los equipos que creó y se puede eliminar un equipo.

Antes de usar la eliminación, ejecutá una sola vez `eliminar_equipo.sql` en Supabase → SQL Editor. La función solo permite al organizador eliminar sus propios equipos. Bloquea la eliminación si el equipo está asignado a una partida pendiente o en curso. Si solo está relacionado con partidas finalizadas, elimina sus registros de progreso y participación; los jugadores quedan sin equipo, pero se conservan sus cuentas y puntos totales. La eliminación es permanente.


## Diagnóstico al agregar equipos
El botón ahora muestra confirmación visible cuando el equipo queda guardado y verifica la fila en `participantes_partida`. Si Supabase rechaza la operación, muestra el error exacto en una alerta y en la pantalla para facilitar el diagnóstico. No se requiere SQL adicional para esta mejora de interfaz.
