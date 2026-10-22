(() => {
  "use strict";

  // Aplicación real: requiere config.js, Supabase Auth y el esquema SQL del proyecto.
  const $ = (selector) => document.querySelector(selector);
  const screens = [
    "pantalla-login", "pantalla-registro", "pantalla-inicio", "pantalla-juego",
    "pantalla-menu-partidas", "pantalla-ranking-final", "pantalla-crear-partida",
    "pantalla-crear-equipo", "pantalla-solicitudes-equipo", "pantalla-unirse-partida", "pantalla-perfil", "pantalla-administrar-partidas", "pantalla-administrar-equipos"
  ];
  const messages = {
    login: $("#mensaje-login"),
    registro: $("#mensaje-registro"),
    unirse: $("#mensaje-unirse"),
    crearEquipo: $("#mensaje-crear-equipo"),
    crearPartida: $("#mensaje-crear-partida"),
    solicitudesEquipo: $("#mensaje-solicitudes-equipo")
  };
  const INTERNAL_DOMAIN = "example.com";
  let db = null;
  let currentUser = null;
  let currentProfile = null;
  let busy = false;
  let gpsWatchId = null;
  let playerPosition = null;
  let liveMap = null;
  let livePlayerMarker = null;
  let currentPointIndex = 0;
  let currentPartidaId = null;
  let plazaUnlocked = false;
  let matchClockInterval = null;
  let currentMatchStartedAt = null;
  let currentMatchDurationMinutes = null;
  let lastCloseCheckAt = 0;
  let currentRankingPartidaId = null;

  // Alias sintácticamente válido para cuentas de jugadores sin correo propio.
  // Los jugadores usan nombre de usuario; los organizadores pueden entrar con su correo real.
  // Desactivá la confirmación por email en Supabase porque las cuentas de jugador no reciben correo.
  const usernameEmail = (name) => `${String(name || "").trim().toLowerCase()}@${INTERNAL_DOMAIN}`;
  const validUsername = (name) => /^[a-zA-Z0-9_.-]{3,24}$/.test(name);

  function showScreen(id) {
    screens.forEach((screenId) => {
      const node = document.getElementById(screenId);
      if (node) node.hidden = screenId !== id;
    });
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function clearMessages() {
    Object.values(messages).forEach((node) => { if (node) node.textContent = ""; });
    ["mensaje-crear-equipo", "mensaje-crear-partida", "mensaje-solicitudes-equipo"].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.textContent = "";
    });
  }

  function message(which, text, isError = false) {
    const node = messages[which];
    if (!node) return;
    node.textContent = text || "";
    node.style.color = isError ? "var(--color-error)" : "var(--color-acento)";
  }

  function setBusy(value) {
    busy = value;
    document.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = value; });
  }

  function explainError(error) {
    const text = String(error?.message || error || "");
    const lower = text.toLowerCase();
    if (/invalid login credentials|invalid email or password/.test(lower)) return "El usuario o la contraseña son incorrectos.";
    if (/user already registered|already exists|duplicate key|unique constraint/.test(lower)) return "Ese nombre de usuario ya está registrado. Elegí otro.";
    if (/password should be at least|password.*characters/.test(lower)) return "La contraseña debe tener al menos 8 caracteres.";
    if (/email not confirmed/.test(lower)) return "La confirmación por correo está activada. Desactivala en Supabase Auth para usar cuentas de usuario y contraseña.";
    if (/failed to fetch|networkerror|network request failed|load failed/.test(lower)) return "No se pudo conectar con el servidor. Revisá tu conexión.";
    if (/function .* does not exist|could not find the function|schema cache/.test(lower)) return "Falta crear una función SQL requerida en Supabase. La definiremos en la etapa de base de datos.";
    if (/permission denied|row-level security|violates row-level security/.test(lower)) return "Supabase rechazó la operación por permisos. Hay que revisar las políticas de seguridad.";
    if (/invalid.*code|code.*not found|partida.*no existe|no existe.*partida/.test(lower)) return "No encontramos una partida con ese código.";
    return text || "Ocurrió un error inesperado.";
  }

  async function loadConfig() {
    if (!window.TESORO_CONFIG) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "./config.js";
        script.onload = resolve;
        script.onerror = () => reject(new Error("No se pudo cargar config.js."));
        document.head.appendChild(script);
      });
    }
    const config = window.TESORO_CONFIG;
    if (!config?.supabaseUrl || !config?.supabaseAnonKey) throw new Error("Faltan supabaseUrl o supabaseAnonKey en config.js.");
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    db = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  }

  async function getProfile(authUser) {
    const { data, error } = await db.from("perfiles")
      .select("id, nombre_usuario, puntos_totales, rol").eq("id", authUser.id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("No existe el perfil de esta cuenta. Revisá el trigger crear_perfil_usuario en Supabase.");
    return data;
  }

  async function loadPlayerTeamStatus() {
    const statusBox = $("#estado-equipo-jugador");
    const detail = $("#detalle-estado-equipo");
    const teamCode = $("#codigo-mi-equipo");
    const matchStatus = $("#estado-partida-equipo");
    const joinActions = $("#acciones-jugador");
    const leaveButton = $("#abandonar-equipo");
    const leaveMessage = $("#mensaje-abandonar-equipo");
    if (leaveButton) leaveButton.hidden = true;
    if (leaveMessage) { leaveMessage.hidden = true; leaveMessage.textContent = ""; }
    if (!currentUser || currentProfile?.rol !== "jugador") {
      statusBox.hidden = true;
      if (joinActions) joinActions.hidden = true;
      if (leaveButton) leaveButton.hidden = true;
      const refreshButton = $("#actualizar-estado-equipo");
      if (refreshButton) refreshButton.hidden = true;
      return;
    }
    const refreshButton = $("#actualizar-estado-equipo");
    if (refreshButton) refreshButton.hidden = false;

    statusBox.hidden = false;
    detail.textContent = "Consultando tu estado...";
    teamCode.hidden = true;
    matchStatus.hidden = true;
    joinActions.hidden = true;
    const gpsButton = $("#abrir-juego-gps");
    if (gpsButton) gpsButton.hidden = true;
    currentPartidaId = null;

    try {
      const { data: member, error: memberError } = await db
        .from("integrantes_equipo")
        .select("usuario_id, equipo_id, estado_equipo")
        .eq("usuario_id", currentUser.id)
        .maybeSingle();
      if (memberError) throw memberError;

      if (!member || !member.equipo_id || member.estado_equipo === "sin_equipo") {
        $("#titulo-estado-equipo").textContent = "Todavía no tenés equipo";
        detail.textContent = "Podés solicitar unirte a un equipo usando el código que te compartió el organizador.";
        joinActions.hidden = false;
        return;
      }

      if (member.estado_equipo === "solicitado") {
        $("#titulo-estado-equipo").textContent = "Solicitud pendiente";
        detail.textContent = "Tu solicitud fue enviada. El organizador todavía debe aceptarla.";
        return;
      }

      if (member.estado_equipo !== "aceptado") {
        $("#titulo-estado-equipo").textContent = "Estado del equipo";
        detail.textContent = "No pudimos determinar tu estado de incorporación. Actualizá para volver a consultar.";
        joinActions.hidden = false;
        return;
      }

      const { data: team, error: teamError } = await db
        .from("equipos")
        .select("id, nombre, codigo, activo")
        .eq("id", member.equipo_id)
        .maybeSingle();
      if (teamError) throw teamError;

      $("#titulo-estado-equipo").textContent = "Ya pertenecés a un equipo";
      detail.textContent = team
        ? `Equipo: ${team.nombre}${team.activo === false ? " (inactivo)" : ""}`
        : "Tu incorporación fue aceptada, pero no pudimos cargar los datos del equipo.";
      if (team) {
        teamCode.textContent = `Código del equipo: ${team.codigo}`;
        teamCode.hidden = false;
      }

      // El botón permanece bloqueado hasta comprobar los estados de las partidas.
      joinActions.hidden = true;
      if (leaveButton) {
        leaveButton.hidden = false;
        leaveButton.disabled = true;
        leaveButton.textContent = "Comprobando partidas...";
        leaveButton.title = "Estamos comprobando si el equipo tiene una partida pendiente o en curso.";
      }

      // Consultar la asignación y la partida por separado para evitar depender
      // de una relación embebida de PostgREST que puede quedar filtrada por RLS.
      if (team?.id) {
        const { data: participations, error: participationError } = await db
          .from("participantes_partida")
          .select("partida_id")
          .eq("equipo_id", team.id);
        if (participationError) throw participationError;

        const matchIds = [...new Set((participations || []).map(row => row.partida_id).filter(Boolean))];
        let matches = [];
        if (matchIds.length) {
          const { data: matchRows, error: matchesError } = await db
            .from("partidas")
            .select("id, nombre, codigo, estado, iniciada_en, duracion_minutos")
            .in("id", matchIds);
          if (matchesError) throw matchesError;
          matches = matchRows || [];
        }

        // Regla de negocio: no se puede abandonar si existe una partida
        // asociada al equipo en espera o en curso.
        const blockingMatch = matches.find(match => ["esperando", "en_curso"].includes(match.estado));
        const activeMatch = matches.find(match => match.estado === "en_curso");
        const visibleMatch = activeMatch || matches.find(match => match.estado === "esperando") || matches.find(match => match.estado === "finalizada");
        if (leaveButton) {
          leaveButton.disabled = Boolean(blockingMatch);
          leaveButton.textContent = blockingMatch ? "Abandonar equipo (bloqueado)" : "Abandonar equipo";
          leaveButton.title = blockingMatch
            ? "No podés abandonar mientras el equipo tenga una partida en espera o en curso."
            : "Abandonar el equipo para poder solicitar unirte a otro.";
        }
        if (blockingMatch) {
          matchStatus.textContent = `No podés abandonar el equipo mientras la partida «${blockingMatch.nombre || blockingMatch.codigo || blockingMatch.id}» esté ${blockingMatch.estado === "esperando" ? "en espera" : "en curso"}.`;
          matchStatus.hidden = false;
        } else if (visibleMatch) {
          matchStatus.textContent = `Partida: ${visibleMatch.nombre || visibleMatch.codigo || visibleMatch.id} · Estado: ${visibleMatch.estado}`;
          matchStatus.hidden = false;
        } else {
          matchStatus.textContent = "Tu equipo todavía no tiene una partida visible. Si el organizador ya la inició, pulsá «Actualizar estado».";
          matchStatus.hidden = false;
        }
        if (activeMatch && gpsButton) {
          currentPartidaId = activeMatch.id;
          currentMatchStartedAt = activeMatch.iniciada_en || null;
          currentMatchDurationMinutes = Number(activeMatch.duracion_minutos || 0);
          startMatchClock();
          gpsButton.hidden = false;
          gpsButton.textContent = "Entrar a la búsqueda del tesoro";
        }
      }
    } catch (error) {
      $("#titulo-estado-equipo").textContent = "No pudimos consultar tu equipo";
      detail.textContent = explainError(error);
      // Si no se pudo verificar el estado de las partidas, bloquear la salida por seguridad.
      if (leaveButton) {
        leaveButton.hidden = false;
        leaveButton.disabled = true;
        leaveButton.textContent = "Abandonar equipo (bloqueado)";
        leaveButton.title = "No se pudo verificar el estado de las partidas. Actualizá el estado antes de intentar salir.";
      }
      // Evitar mostrar un botón para volver a solicitar si el estado real no pudo leerse.
      joinActions.hidden = true;
      console.error("Error al consultar el estado del equipo:", error);
    }
  }

  async function openHome(authUser) {
    const profile = await getProfile(authUser);
    currentUser = authUser;
    currentProfile = profile;
    const name = profile.nombre_usuario || "Jugador";
    const isOrganizer = profile.rol === "organizador";
    $("#acciones-organizador").hidden = !isOrganizer;
    $("#acciones-jugador").hidden = isOrganizer;
    // La consulta del equipo pertenece exclusivamente a las cuentas de jugador.
    const playerTeamStatus = $("#estado-equipo-jugador");
    const refreshPlayerTeam = $("#actualizar-estado-equipo");
    if (playerTeamStatus) playerTeamStatus.hidden = isOrganizer;
    if (refreshPlayerTeam) refreshPlayerTeam.hidden = isOrganizer;
    const points = String(Number(profile.puntos_totales || 0));
    $("#nombre-usuario").textContent = name;
    $("#total-puntos").textContent = points;
    $("#perfil-nombre-usuario").textContent = name;
    $("#perfil-total-puntos").textContent = points;
    const rank = getRank(Number(profile.puntos_totales || 0));
    ["rango-usuario", "perfil-rango-usuario"].forEach((id) => { const tag = $("#" + id); if (tag) { tag.textContent = rank.label; tag.className = "rank-tag " + rank.css; } });
    showScreen("pantalla-inicio");
    if (!isOrganizer) {
      await loadPlayerTeamStatus();
      await checkPendingRanking();
    }
  }

  function updateTutorFields() {
    const age = Number($("#registro-edad").value);
    const required = Number.isFinite(age) && age > 0 && age < 18;
    const block = $("#bloque-tutor");
    block.hidden = !required;
    $("#registro-tutor-nombre").required = required;
    $("#registro-tutor-apellido").required = required;
    $("#registro-tutor-autorizacion").required = required;
    if (!required) {
      $("#registro-tutor-nombre").value = "";
      $("#registro-tutor-apellido").value = "";
      $("#registro-tutor-autorizacion").checked = false;
    }
  }

  async function register(event) {
    event.preventDefault();
    if (busy) return;
    clearMessages();
    const name = $("#registro-usuario").value.trim().toLowerCase();
    const password = $("#registro-contrasena").value;
    const confirm = $("#registro-confirmar-contrasena").value;
    const nombre = $("#registro-nombre").value.trim();
    const apellido = $("#registro-apellido").value.trim();
    const edad = Number($("#registro-edad").value);
    const telefono = $("#registro-telefono").value.trim();
    const instagram = $("#registro-instagram").value.trim();
    const consentimiento = $("#registro-consentimiento").checked;
    const esMenor = edad < 18;
    const tutorNombre = $("#registro-tutor-nombre").value.trim();
    const tutorApellido = $("#registro-tutor-apellido").value.trim();
    const tutorAutorizacion = $("#registro-tutor-autorizacion").checked;

    if (!validUsername(name)) { message("registro", "El usuario debe tener entre 3 y 24 caracteres: letras, números, punto, guion o guion bajo.", true); return; }
    if (password.length < 8) { message("registro", "La contraseña debe tener al menos 8 caracteres.", true); return; }
    if (password !== confirm) { message("registro", "Las contraseñas no coinciden.", true); return; }
    if (!nombre || !apellido || !Number.isInteger(edad) || edad < 1 || edad > 120 || !telefono) { message("registro", "Completá nombre, apellido, edad y teléfono correctamente.", true); return; }
    if (!consentimiento) { message("registro", "Debés aceptar el consentimiento de participación.", true); return; }
    if (esMenor && (!tutorNombre || !tutorApellido || !tutorAutorizacion)) { message("registro", "Para menores de 18 años se requiere nombre y apellido del tutor y su autorización.", true); return; }

    setBusy(true);
    try {
      const { data, error } = await db.auth.signUp({
        email: usernameEmail(name), password,
        options: { data: { nombre_usuario: name } }
      });
      if (error) throw error;
      if (!data.session || !data.user) {
        message("registro", "Supabase no inició sesión tras el registro. Desactivá la confirmación por correo en Supabase Auth para este sistema de usuarios.", true); return;
      }
      // Los datos personales se guardan mediante RPC: nunca se permite elegir otro usuario_id.
      const { error: profileError } = await db.rpc("guardar_datos_participante", {
        p_nombre: nombre,
        p_apellido: apellido,
        p_edad: edad,
        p_telefono: telefono,
        p_instagram: instagram || null,
        p_consentimiento: consentimiento,
        p_tutor_nombre: esMenor ? tutorNombre : null,
        p_tutor_apellido: esMenor ? tutorApellido : null,
        p_tutor_autorizacion: esMenor ? tutorAutorizacion : false
      });
      if (profileError) throw profileError;
      await getProfile(data.user);
      await db.auth.signOut();
      $("#form-registro").reset();
      updateTutorFields();
      $("#login-usuario").value = name;
      $("#login-contrasena").value = "";
      showScreen("pantalla-login");
      message("login", "Cuenta y datos de participante creados correctamente. Iniciá sesión para continuar.");
    } catch (error) {
      message("registro", explainError(error), true);
      console.error("Error al registrar:", error);
    } finally { setBusy(false); }
  }

  async function login(event) {
    event.preventDefault();
    if (busy) return;
    clearMessages();
    const name = $("#login-usuario").value.trim().toLowerCase();
    const password = $("#login-contrasena").value;
    if (!name || !password) { message("login", "Ingresá tu usuario o correo y contraseña.", true); return; }
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name);
    if (!isEmail && !validUsername(name)) { message("login", "Ingresá un nombre de usuario válido o un correo electrónico.", true); return; }

    setBusy(true);
    try {
      const { data, error } = await db.auth.signInWithPassword({ email: isEmail ? name : usernameEmail(name), password });
      if (error) throw error;
      await openHome(data.user);
      $("#form-login").reset();
    } catch (error) {
      message("login", explainError(error), true);
      console.error("Error al iniciar sesión:", error);
    } finally { setBusy(false); }
  }

  async function logout() {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await db.auth.signOut();
      if (error) throw error;
      currentUser = null;
      currentProfile = null;
      $("#form-login").reset();
      clearMessages();
      showScreen("pantalla-login");
    } catch (error) {
      window.alert(`No se pudo cerrar la sesión: ${explainError(error)}`);
    } finally { setBusy(false); }
  }

  async function createMatch(event) {
    event.preventDefault();
    if (busy) return;
    if (!currentUser) { showScreen("pantalla-login"); return; }
    setBusy(true);
    $("#resultado-partida").hidden = true;
    try {
      const minJugadores = Number($("#min-integrantes").value);
      const maxJugadores = Number($("#max-integrantes").value);
      const duracion = Number($("#duracion-partida").value);
      if (minJugadores < 3 || maxJugadores > 5 || minJugadores > maxJugadores) {
        throw new Error("Los equipos deben tener entre 3 y 5 jugadores y el mínimo no puede superar al máximo.");
      }
      // Firma instalada en Supabase: crear_partida(text, integer, boolean, boolean, integer, integer).
      const { data, error } = await db.rpc("crear_partida", {
        p_nombre: $("#nombre-partida").value.trim(),
        p_duracion_minutos: duracion,
        p_pistas_activadas: $("#pistas-activadas").checked,
        p_gps_activado: $("#gps-activado").checked,
        p_min_integrantes: minJugadores,
        p_max_integrantes: maxJugadores
      });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      const code = typeof result === "string" ? result : result?.codigo || result?.code || result?.codigo_partida;
      if (!code) throw new Error("crear_partida no devolvió un código de sala.");
      $("#codigo-partida").textContent = code;
      $("#resultado-partida").hidden = false;
    } catch (error) {
      window.alert(`No se pudo crear la partida: ${explainError(error)}`);
      console.error("Error al crear partida:", error);
    } finally { setBusy(false); }
  }

  async function loadTeamRequests() {
    const list = $("#lista-solicitudes-equipo");
    const status = $("#mensaje-solicitudes-equipo");
    if (!currentUser || currentProfile?.rol !== "organizador") {
      status.textContent = "Solo los organizadores pueden revisar solicitudes.";
      return;
    }
    list.replaceChildren();
    status.textContent = "Cargando solicitudes...";
    try {
      // La política RLS debe limitar las filas a los equipos del organizador.
      const { data, error } = await db
        .from("integrantes_equipo")
        .select("usuario_id, equipo_id, nombre, apellido, edad, telefono, instagram, creado_en, equipos:equipo_id (id, nombre, codigo, organizador_id)")
        .eq("estado_equipo", "solicitado")
        .order("creado_en", { ascending: true });
      if (error) throw error;

      if (!data || data.length === 0) {
        status.textContent = "No hay solicitudes pendientes.";
        const empty = document.createElement("p");
        empty.textContent = "Cuando un jugador solicite unirse a uno de tus equipos, aparecerá aquí.";
        list.appendChild(empty);
        return;
      }

      status.textContent = `Solicitudes pendientes: ${data.length}`;
      for (const request of data) {
        const team = Array.isArray(request.equipos) ? request.equipos[0] : request.equipos;
        if (!team || team.organizador_id !== currentUser.id) continue;

        const card = document.createElement("article");
        card.className = "request-card";
        const heading = document.createElement("h2");
        heading.textContent = `${request.nombre || ""} ${request.apellido || ""}`.trim() || "Participante";
        const details = document.createElement("p");
        details.textContent = `Equipo: ${team.nombre} · Edad: ${request.edad ?? "No informada"}`;
        const contact = document.createElement("p");
        contact.textContent = `Teléfono: ${request.telefono || "No informado"}${request.instagram ? ` · Instagram: ${request.instagram}` : ""}`;
        const code = document.createElement("p");
        code.textContent = `Código del equipo: ${team.codigo}`;
        const actions = document.createElement("div");
        actions.className = "request-actions";
        const accept = document.createElement("button");
        accept.type = "button";
        accept.textContent = "Aceptar";
        accept.addEventListener("click", () => resolveTeamRequest(request.usuario_id, true));
        const reject = document.createElement("button");
        reject.type = "button";
        reject.className = "secondary";
        reject.textContent = "Rechazar";
        reject.addEventListener("click", () => resolveTeamRequest(request.usuario_id, false));
        actions.append(accept, reject);
        card.append(heading, details, contact, code, actions);
        list.appendChild(card);
      }
      if (!list.childElementCount) {
        status.textContent = "No hay solicitudes pendientes para tus equipos.";
      }
    } catch (error) {
      status.textContent = explainError(error);
      console.error("Error al cargar solicitudes:", error);
    }
  }

  async function resolveTeamRequest(userId, accept) {
    if (busy) return;
    if (currentProfile?.rol !== "organizador") {
      window.alert("Solo los organizadores pueden resolver solicitudes.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await db.rpc("resolver_solicitud_equipo", {
        p_usuario_id: userId,
        p_aceptar: accept
      });
      if (error) throw error;
      $("#mensaje-solicitudes-equipo").textContent = accept
        ? "Solicitud aceptada."
        : "Solicitud rechazada.";
      await loadTeamRequests();
    } catch (error) {
      $("#mensaje-solicitudes-equipo").textContent = explainError(error);
      console.error("Error al resolver solicitud:", error);
    } finally {
      setBusy(false);
    }
  }

  async function createTeam(event) {
    event.preventDefault();
    if (busy) return;
    if (!currentUser || currentProfile?.rol !== "organizador") {
      window.alert("Solo los organizadores pueden crear equipos.");
      return;
    }
    const name = $("#nombre-equipo").value.trim();
    if (!name) {
      $("#mensaje-crear-equipo").textContent = "Ingresá un nombre para el equipo.";
      return;
    }
    setBusy(true);
    $("#resultado-equipo").hidden = true;
    $("#mensaje-crear-equipo").textContent = "";
    try {
      const { data, error } = await db.rpc("crear_equipo", { p_nombre: name });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      const code = result?.codigo || result?.code;
      if (!code) throw new Error("crear_equipo no devolvió un código de equipo.");
      $("#codigo-equipo").textContent = code;
      $("#resultado-equipo").hidden = false;
      $("#mensaje-crear-equipo").textContent = "Equipo creado correctamente.";
    } catch (error) {
      $("#mensaje-crear-equipo").textContent = explainError(error);
      console.error("Error al crear equipo:", error);
    } finally {
      setBusy(false);
    }
  }

  async function leaveTeam() {
    const button = $("#abandonar-equipo");
    const status = $("#mensaje-abandonar-equipo");
    if (!currentUser || currentProfile?.rol !== "jugador") {
      window.alert("Solo los jugadores pueden abandonar un equipo.");
      return;
    }
    if (button.disabled) {
      window.alert("No podés abandonar el equipo hasta comprobar que no tenga una partida en espera o en curso.");
      return;
    }
    if (!window.confirm("¿Estás seguro de que querés abandonar este equipo? Tus datos personales y puntos históricos se conservarán. No podrás salir si el equipo está anotado en una partida pendiente o en curso.")) return;
    button.disabled = true;
    status.hidden = false;
    status.textContent = "Procesando...";
    try {
      const { data, error } = await db.rpc("abandonar_equipo");
      if (error) throw error;
      status.textContent = typeof data === "string" ? data : "Abandonaste el equipo.";
      await loadPlayerTeamStatus();
      window.alert(typeof data === "string" ? data : "Abandonaste el equipo. Ahora podés solicitar unirte a otro.");
    } catch (error) {
      status.textContent = explainError(error);
      status.hidden = false;
      window.alert(`No pudimos abandonar el equipo: ${explainError(error)}`);
      console.error("Error al abandonar equipo:", error);
    } finally {
      button.disabled = false;
    }
  }

  async function joinMatch(event) {
    event.preventDefault();
    if (busy) return;
    if (!currentUser) { showScreen("pantalla-login"); return; }
    clearMessages();
    if (currentProfile?.rol === "organizador") {
      message("unirse", "Las cuentas organizadoras no pueden solicitar ingreso como jugadores.", true);
      return;
    }
    const code = $("#codigo-para-unirse").value.trim().toUpperCase();
    if (!code) { message("unirse", "Ingresá el código del equipo.", true); return; }

    setBusy(true);
    try {
      const { error } = await db.rpc("solicitar_unirse_equipo", { p_codigo: code });
      if (error) throw error;
      message("unirse", "Solicitud enviada. El organizador debe aceptar tu ingreso al equipo.");
      $("#codigo-para-unirse").value = "";
    } catch (error) {
      message("unirse", explainError(error), true);
      console.error("Error al unirse a la partida:", error);
    } finally { setBusy(false); }
  }


  let selectedMatchId = null;

  async function loadOrganizerMatches() {
    const list = $("#lista-partidas-organizador");
    const status = $("#mensaje-administrar-partidas");
    const panel = $("#panel-partida-seleccionada");
    list.replaceChildren();
    panel.hidden = true;
    selectedMatchId = null;
    if (currentProfile?.rol !== "organizador") {
      status.textContent = "Solo los organizadores pueden administrar partidas.";
      return;
    }
    status.textContent = "Cargando tus partidas...";
    try {
      const { data, error } = await db.from("partidas")
        .select("id, nombre, codigo, estado, duracion_minutos, creada_en")
        .eq("organizador_id", currentUser.id)
        .neq("estado", "finalizada")
        .order("creada_en", { ascending: false });
      if (error) throw error;
      if (!data?.length) {
        status.textContent = "No tenés partidas pendientes ni en curso.";
        const p = document.createElement("p");
        p.textContent = "Las partidas finalizadas ya no se muestran aquí. Podés crear una nueva partida para continuar.";
        list.appendChild(p);
        return;
      }
      status.textContent = `Partidas activas o pendientes: ${data.length}. Las finalizadas no se muestran.`;
      for (const match of data) {
        const card = document.createElement("article");
        card.className = "request-card";
        const heading = document.createElement("h2");
        heading.textContent = match.nombre || "Partida sin nombre";
        const details = document.createElement("p");
        details.textContent = `Código: ${match.codigo} · Estado: ${match.estado} · Duración: ${match.duracion_minutos ?? "—"} min`;
        const choose = document.createElement("button");
        choose.type = "button";
        choose.textContent = "Administrar esta partida";
        choose.addEventListener("click", () => selectOrganizerMatch(match));
        card.append(heading, details, choose);
        list.appendChild(card);
      }
    } catch (error) {
      status.textContent = `No se pudieron cargar las partidas: ${explainError(error)}`;
      console.error("Error al cargar partidas del organizador:", error);
    }
  }

  async function selectOrganizerMatch(match) {
    selectedMatchId = match.id;
    $("#panel-partida-seleccionada").hidden = false;
    $("#titulo-partida-seleccionada").textContent = match.nombre || "Partida seleccionada";
    $("#detalle-partida-seleccionada").textContent = `Código: ${match.codigo} · Estado: ${match.estado}`;
    const isRunning = match.estado === "en_curso";
    const isFinished = match.estado === "finalizada";
    $("#iniciar-partida").hidden = isRunning || isFinished;
    // Mostrar terminar para cualquier partida no finalizada, incluso si aún está esperando.
    $("#finalizar-partida").hidden = isFinished;
    $("#finalizar-partida").textContent = isRunning ? "Terminar partida" : "Cancelar partida";
    $("#agregar-equipo-a-partida").disabled = isRunning || isFinished;
    $("#equipo-para-agregar").disabled = isRunning || isFinished;
    await loadTeamsForSelectedMatch();
  }

  async function loadTeamsForSelectedMatch() {
    const status = $("#mensaje-administrar-partidas");
    const select = $("#equipo-para-agregar");
    const list = $("#lista-equipos-partida");
    if (!selectedMatchId) return;
    select.replaceChildren(new Option("Seleccioná un equipo", ""));
    list.replaceChildren();
    try {
      const [{ data: teams, error: teamsError }, { data: participants, error: participantsError }] = await Promise.all([
        db.from("equipos").select("id, nombre, codigo, activo").eq("organizador_id", currentUser.id).eq("activo", true).order("nombre"),
        db.from("participantes_partida").select("equipo_id").eq("partida_id", selectedMatchId)
      ]);
      if (teamsError) throw teamsError;
      if (participantsError) throw participantsError;
      const added = new Set((participants || []).map(p => p.equipo_id));
      const available = (teams || []).filter(t => !added.has(t.id));
      for (const team of available) select.add(new Option(`${team.nombre} (${team.codigo})`, team.id));
      if (!available.length) select.add(new Option("No hay equipos disponibles para agregar", ""));
      if (!participants?.length) {
        const p = document.createElement("p"); p.textContent = "Todavía no hay equipos agregados a esta partida."; list.appendChild(p);
      } else {
        for (const participant of participants) {
          const team = (teams || []).find(t => t.id === participant.equipo_id);
          const p = document.createElement("p");
          p.textContent = team ? `${team.nombre} · Código: ${team.codigo}` : `Equipo agregado (${participant.equipo_id})`;
          list.appendChild(p);
        }
      }
      status.textContent = "Partida seleccionada. Podés agregar un equipo aceptado.";
    } catch (error) {
      status.textContent = `No se pudieron cargar los equipos: ${explainError(error)}`;
      console.error("Error al cargar equipos de partida:", error);
    }
  }

  async function addTeamToSelectedMatch() {
    const teamId = $("#equipo-para-agregar").value;
    const status = $("#mensaje-administrar-partidas");
    const button = $("#agregar-equipo-a-partida");
    if (!selectedMatchId) {
      status.textContent = "Primero seleccioná una partida.";
      window.alert("Primero seleccioná una partida.");
      return;
    }
    if (!teamId) {
      status.textContent = "Seleccioná un equipo disponible en la lista.";
      window.alert("Seleccioná un equipo disponible en la lista.");
      return;
    }
    if (busy) return;
    const chosenLabel = $("#equipo-para-agregar").selectedOptions[0]?.textContent || "el equipo seleccionado";
    setBusy(true);
    button.disabled = true;
    status.textContent = `Agregando ${chosenLabel} a la partida...`;
    try {
      const { error } = await db.rpc("agregar_equipo_partida", {
        p_partida_id: selectedMatchId,
        p_equipo_id: teamId
      });
      if (error) throw error;

      // Verificar que la relación realmente quedó guardada en Supabase.
      const { data: saved, error: verifyError } = await db
        .from("participantes_partida")
        .select("partida_id, equipo_id")
        .eq("partida_id", selectedMatchId)
        .eq("equipo_id", teamId)
        .maybeSingle();
      if (verifyError) throw verifyError;
      if (!saved) {
        throw new Error("Supabase no confirmó que el equipo quedara asociado a la partida. Revisá la función agregar_equipo_partida y sus permisos.");
      }

      status.textContent = `${chosenLabel} se agregó correctamente a la partida.`;
      await loadTeamsForSelectedMatch();
      window.alert(`${chosenLabel} se agregó correctamente a la partida.`);
    } catch (error) {
      const detail = explainError(error);
      status.textContent = `No se pudo agregar el equipo: ${detail}`;
      window.alert(`No se pudo agregar el equipo: ${detail}`);
      console.error("Error al agregar equipo a partida:", error);
    } finally {
      button.disabled = false;
      setBusy(false);
    }
  }

  async function startSelectedMatch() {
    const status = $("#mensaje-administrar-partidas");
    if (!selectedMatchId || busy) return;
    if (!window.confirm("¿Querés iniciar esta partida? Los equipos deberán cumplir los requisitos configurados.")) return;
    setBusy(true);
    status.textContent = "Iniciando partida...";
    try {
      const { error } = await db.rpc("iniciar_partida", { p_partida_id: selectedMatchId });
      if (error) throw error;
      status.textContent = "¡Partida iniciada correctamente!";
      await loadOrganizerMatches();
    } catch (error) {
      status.textContent = `No se pudo iniciar la partida: ${explainError(error)}`;
      console.error("Error al iniciar partida:", error);
    } finally { setBusy(false); }
  }

  async function finishSelectedMatch() {
    const status = $("#mensaje-administrar-partidas");
    if (!selectedMatchId || busy) return;
    if (!window.confirm("¿Querés terminar esta partida? Esta acción la marcará como finalizada.")) return;
    setBusy(true);
    status.textContent = "Terminando partida...";
    try {
      const { error } = await db.rpc("finalizar_partida", { p_partida_id: selectedMatchId });
      if (error) throw error;

      // Verificar en la base que el cambio realmente se haya guardado.
      const { data: updatedMatch, error: verifyError } = await db
        .from("partidas")
        .select("id, nombre, codigo, estado, duracion_minutos, creada_en")
        .eq("id", selectedMatchId)
        .maybeSingle();
      if (verifyError) throw verifyError;
      if (!updatedMatch || updatedMatch.estado !== "finalizada") {
        throw new Error("Supabase no confirmó el estado 'finalizada'. Verificá que ejecutaste finalizar_partida.sql en el SQL Editor del proyecto correcto.");
      }

      status.textContent = "Partida finalizada correctamente.";
      await selectOrganizerMatch(updatedMatch);
      await loadOrganizerMatches();
    } catch (error) {
      status.textContent = `No se pudo terminar la partida: ${explainError(error)}`;
      window.alert(`No se pudo terminar la partida: ${explainError(error)}`);
      console.error("Error al terminar partida:", error);
    } finally { setBusy(false); }
  }

  async function loadOrganizerTeams() {
    const list = $("#lista-equipos-organizador");
    const status = $("#mensaje-administrar-equipos");
    list.replaceChildren();
    if (currentProfile?.rol !== "organizador") {
      status.textContent = "Solo los organizadores pueden administrar equipos.";
      return;
    }
    status.textContent = "Cargando tus equipos...";
    try {
      const { data, error } = await db.from("equipos")
        .select("id, nombre, codigo, activo, creado_en")
        .eq("organizador_id", currentUser.id)
        .order("creado_en", { ascending: false });
      if (error) throw error;
      if (!data?.length) {
        status.textContent = "Todavía no creaste equipos.";
        const empty = document.createElement("p");
        empty.textContent = "Cuando crees un equipo, aparecerá en esta sección.";
        list.appendChild(empty);
        return;
      }
      status.textContent = `Tus equipos: ${data.length}.`;
      for (const team of data) {
        const card = document.createElement("article");
        card.className = "request-card";
        const heading = document.createElement("h2");
        heading.textContent = team.nombre;
        const details = document.createElement("p");
        details.textContent = `Código: ${team.codigo} · Estado: ${team.activo === false ? "Inactivo" : "Activo"}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Eliminar equipo";
        remove.addEventListener("click", () => deleteOrganizerTeam(team));
        card.append(heading, details, remove);
        list.appendChild(card);
      }
    } catch (error) {
      status.textContent = `No se pudieron cargar los equipos: ${explainError(error)}`;
      console.error("Error al cargar equipos del organizador:", error);
    }
  }

  async function deleteOrganizerTeam(team) {
    if (busy || currentProfile?.rol !== "organizador") return;
    const confirmed = window.confirm(`¿Querés eliminar el equipo «${team.nombre}»? Sus integrantes quedarán sin equipo y se quitará el equipo de las partidas finalizadas. No se borrarán los puntos totales de los jugadores. Esta acción no se puede deshacer.`);
    if (!confirmed) return;
    const status = $("#mensaje-administrar-equipos");
    setBusy(true);
    status.textContent = `Eliminando el equipo ${team.nombre}...`;
    try {
      const { error } = await db.rpc("eliminar_equipo", { p_equipo_id: team.id });
      if (error) throw error;
      status.textContent = `El equipo «${team.nombre}» fue eliminado.`;
      await loadOrganizerTeams();
    } catch (error) {
      status.textContent = `No se pudo eliminar el equipo: ${explainError(error)}`;
      console.error("Error al eliminar equipo:", error);
    } finally {
      setBusy(false);
    }
  }

  const GAME_POINTS = [
    { id:"P01", name:"Monumento a Nicolás Rodríguez Peña", lat:-34.597386, lng:-58.392979, clue:"Un monumento recuerda a quien da nombre a la plaza.", question:"¿Qué año figura en el monumento?", answers:["1775","1853","1939"] },
    { id:"P02", name:"Monumento a Bernardo de Irigoyen", lat:-34.598424, lng:-58.392772, clue:"Buscá el monumento dedicado a Bernardo de Irigoyen.", question:"¿Cuántos escalones hay en el podio?", answers:["12","doce"] },
    { id:"P03", name:"Busto de Juan Bautista de La Salle", lat:-34.598548, lng:-58.391931, clue:"Encontrá el busto de un educador.", question:"¿De qué material es el busto?", answers:["bronce"] },
    { id:"P04", name:"Fuente El Sediento", lat:-34.5979241, lng:-58.3927415, clue:"Buscá la fuente de la plaza.", question:"¿Qué forma tiene la pileta?", answers:["trebol","tres circulos","3 circulos"] },
    { id:"P05", name:"Garita Buenos Aires Ciudad", lat:-34.5980299, lng:-58.3923486, clue:"Una casita redonda que nunca duerme, con el nombre de la ciudad en frente.", question:"¿Qué dice arriba de la garita?", answers:["buenos aires ciudad","buenos aires, ciudad"] },
    { id:"P06", name:"Árbol Tortuga", lat:-34.598211, lng:-58.392546, clue:"Una planta con nombre de un reptil.", question:"¿A qué parte de la tortuga se parece la copa?", answers:["caparazon","cupula","casco"] },
    { id:"P07", name:"Canil", lat:-34.598461, lng:-58.392334, clue:"Lugar especial para el mejor amigo del hombre.", question:"¿De qué color son las rejas?", answers:["gris","plateado","plata"] },
    { id:"P08", name:"Parque Infantil", lat:-34.597679, lng:-58.392169, clue:"El centro de la imaginación y las amistades entre niños.", question:"¿De qué color es el tobogán?", answers:["amarillo","oro","dorado"] },
    { id:"P09", name:"Cancha de fútbol-tenis", lat:-34.5972173, lng:-58.3926533, clue:"Rincón ideal para ejercitar.", question:"¿Cuántas canchas hay?", answers:["dos","2"] },
    { id:"P10", name:"Zona de mesas", lat:-34.5977753, lng:-58.3920071, clue:"Sitio para reposar y jugar al ajedrez.", question:"¿De qué están hechas las mesas?", answers:["piedra","roca","cemento"] },
    { id:"TESORO", name:"Estatua de la Sirena · Tesoro final", lat:-34.5974674, lng:-58.3931808, clue:"Una estatua que busca a su gemela, cuya pista fue resuelta.", question:"¿De qué material está hecha la estatua?", answers:["marmol"] }
  ];
  function getRank(points) {
    if (points >= 2001) return {label:"LEYENDA",css:"rank-leyenda"};
    if (points >= 1001) return {label:"CAZATESOROS",css:"rank-cazatesoros"};
    if (points >= 501) return {label:"VETERANO",css:"rank-veterano"};
    if (points >= 101) return {label:"APRENDIZ",css:"rank-aprendiz"};
    return {label:"NOVATO",css:"rank-novato"};
  }
  function distanceMeters(a,b,c,d) {
    const rad = v => v * Math.PI / 180;
    const R = 6371000, dLat=rad(c-a), dLng=rad(d-b);
    const q=Math.sin(dLat/2)**2+Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(dLng/2)**2;
    return 2*R*Math.atan2(Math.sqrt(q),Math.sqrt(1-q));
  }
  // Perímetro aproximado de la plaza ampliado con 15 m de margen.
  function insidePlaza(lat,lng) {
    const latMargin=15/111320, lngMargin=15/(111320*Math.cos(lat*Math.PI/180));
    return lat >= -34.5990-latMargin && lat <= -34.5969+latMargin && lng >= -58.3935-lngMargin && lng <= -58.3914+lngMargin;
  }
  function normalizeAnswer(value) {
    return String(value||"").toLocaleLowerCase("es-AR").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\b(el|la|los|las|un|una|unos|unas)\b/g," ").replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," ");
  }
  function renderCurrentPoint() {
    const p=GAME_POINTS[currentPointIndex];
    if (!p) return;
    $("#progreso-punto").textContent = p.id === "TESORO" ? "Desafío final" : `Punto ${currentPointIndex+1} de 10`;
    $("#elemento-punto").textContent = `${p.id} · ${p.name}`;
    $("#pista-punto").textContent = `Pista: ${p.clue}`;
    $("#pregunta-punto").textContent = p.question;
    $("#respuesta-punto").value="";
    updatePointGpsState();
  }
  function updatePointGpsState() {
    const p=GAME_POINTS[currentPointIndex]; if(!p || !playerPosition) return;
    const distance=distanceMeters(playerPosition.latitude,playerPosition.longitude,p.lat,p.lng);
    const enabled=distance<=15;
    $("#estado-punto-gps").textContent=enabled ? `Estás a ${Math.round(distance)} m. Ya podés responder.` : `Acercate a 15 metros del punto. Distancia actual: ${Math.round(distance)} m.`;
    $("#respuesta-punto").disabled=!enabled;
    $("#enviar-respuesta-punto").disabled=!enabled;
  }
  function updateLiveMap(position) {
    const mapNode = $("#mapa-juego");
    if (!mapNode || !window.L) return;
    const latlng = [position.coords.latitude, position.coords.longitude];
    const plazaCenter = [-34.59795, -58.39255];
    if (!liveMap) {
      liveMap = L.map(mapNode, { zoomControl: true, attributionControl: true }).setView(plazaCenter, 17);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 20,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'
      }).addTo(liveMap);
      const pulseIcon = L.divIcon({
        className: "",
        html: '<span class="gps-pulse-marker" aria-label="Tu ubicación GPS"></span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      livePlayerMarker = L.marker(latlng, { icon: pulseIcon, title: "Tu ubicación" }).addTo(liveMap);
      livePlayerMarker.bindPopup("Estás acá");
    } else {
      livePlayerMarker.setLatLng(latlng);
    }
    // La primera vez centra en el jugador; luego actualiza el punto sin forzar el zoom.
    if (!mapNode.dataset.centered) {
      liveMap.setView(latlng, 18);
      mapNode.dataset.centered = "1";
    }
    window.setTimeout(() => liveMap && liveMap.invalidateSize(), 100);
  }

  function handlePosition(position) {
    playerPosition=position.coords;
    updateLiveMap(position);
    plazaUnlocked=insidePlaza(playerPosition.latitude,playerPosition.longitude);
    $("#estado-gps-juego").textContent=`Precisión GPS aproximada: ${Math.round(playerPosition.accuracy)} m.`;
    $("#mapa-bloqueado").hidden=plazaUnlocked;
    $("#contenido-juego").hidden=!plazaUnlocked;
    if(plazaUnlocked) {
      $("#distancia-plaza").textContent="Ubicación confirmada: estás dentro de la zona de juego.";
      if(!$("#progreso-punto").dataset.loaded){$("#progreso-punto").dataset.loaded="1";renderCurrentPoint();}
      updatePointGpsState();
    } else {
      $("#estado-gps-juego").textContent="Acercate a la plaza Rodríguez Peña para poder jugar.";
    }
  }
  function startGpsGame() {
    if(!navigator.geolocation){$("#estado-gps-juego").textContent="Este navegador no permite usar la ubicación.";return;}
    $("#estado-gps-juego").textContent="Solicitando permiso de ubicación…";
    navigator.geolocation.getCurrentPosition(
      handlePosition,
      e => {
        const text = e.code === 1
          ? "Necesitás permitir el acceso a la ubicación para jugar."
          : e.code === 3
            ? "La ubicación tardó demasiado. Comprobá que el GPS esté activo y volvé a intentarlo."
            : "No pudimos obtener tu ubicación. Revisá los permisos del navegador y la señal GPS.";
        $("#estado-gps-juego").textContent = text;
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
    if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = navigator.geolocation.watchPosition(
      handlePosition,
      e => {
        $("#estado-gps-juego").textContent = e.code === 1
          ? "Necesitás permitir el acceso a la ubicación para jugar."
          : e.code === 3
            ? "La ubicación está tardando. Mantené el GPS activo y esperá unos segundos."
            : "Se perdió la señal GPS. Comprobá los permisos y que la ubicación esté activada.";
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 }
    );
  }
  async function loadIndividualProgress() {
    if (!currentPartidaId || !currentUser) throw new Error("No encontramos una partida activa asignada a tu usuario.");
    const { data, error } = await db.from("progreso_jugador")
      .select("puntos, siguiente_objetivo, objetivos_completados, terminado")
      .eq("partida_id", currentPartidaId).eq("usuario_id", currentUser.id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("No existe el progreso individual para esta partida. Actualizá el estado y, si continúa, avisale al organizador.");
    currentPointIndex = Math.min(Math.max(Number(data.siguiente_objetivo || 1) - 1, 0), GAME_POINTS.length - 1);
    if (data.terminado) {
      $("#mensaje-respuesta-punto").textContent = `Ya terminaste esta partida. Tus puntos en esta partida: ${data.puntos}.`;
      $("#respuesta-punto").disabled = true;
      $("#enviar-respuesta-punto").disabled = true;
      return false;
    }
    renderCurrentPoint();
    $("#mensaje-respuesta-punto").textContent = `Progreso recuperado: ${data.objetivos_completados} objetivos · ${data.puntos} puntos.`;
    return true;
  }

  async function submitPointAnswer(event) {
    event.preventDefault();
    const p = GAME_POINTS[currentPointIndex];
    if (!p || !playerPosition || !currentPartidaId || !currentUser) {
      $("#mensaje-respuesta-punto").textContent = "No hay una partida activa o todavía no tenemos tu ubicación.";
      return;
    }
    const distance = distanceMeters(playerPosition.latitude, playerPosition.longitude, p.lat, p.lng);
    if (distance > 15 || Number(playerPosition.accuracy) > 100) {
      updatePointGpsState();
      $("#mensaje-respuesta-punto").textContent = "Acercate al objetivo y esperá una señal GPS más precisa.";
      return;
    }
    const button = $("#enviar-respuesta-punto");
    button.disabled = true;
    $("#mensaje-respuesta-punto").textContent = "Validando respuesta y guardando puntos…";
    try {
      const { data, error } = await db.rpc("responder_objetivo", {
        p_partida_id: currentPartidaId,
        p_objetivo_codigo: p.id,
        p_respuesta: $("#respuesta-punto").value,
        p_lat: playerPosition.latitude,
        p_lng: playerPosition.longitude,
        p_precision_m: playerPosition.accuracy
      });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      if (!result) throw new Error("Supabase no devolvió el resultado de la validación.");
      $("#mensaje-respuesta-punto").textContent = `${result.mensaje} ${result.correcto ? `+${result.puntos_ganados} puntos. Total de esta partida: ${result.puntos_totales_partida}.` : ""}`;
      if (!result.correcto) return;
      const { data: profileData, error: profileError } = await db.from("perfiles").select("puntos_totales").eq("id", currentUser.id).maybeSingle();
      if (!profileError && profileData) {
        const total = Number(profileData.puntos_totales || 0);
        $("#total-puntos").textContent = String(total);
        $("#perfil-total-puntos").textContent = String(total);
        const rank = getRank(total);
        ["rango-usuario", "perfil-rango-usuario"].forEach(id => { const tag = $("#" + id); if (tag) { tag.textContent = rank.label; tag.className = "rank-tag " + rank.css; } });
      }
      if (result.partida_finalizada) {
        await processMatchClosure(true);
        return;
      }
      if (Number(result.siguiente_objetivo) > GAME_POINTS.length) return;
      currentPointIndex = Number(result.siguiente_objetivo) - 1;
      renderCurrentPoint();
    } catch (error) {
      $("#mensaje-respuesta-punto").textContent = explainError(error);
      console.error("No se pudo validar el objetivo:", error);
    } finally {
      if (currentPartidaId && playerPosition && currentPointIndex < GAME_POINTS.length) updatePointGpsState();
    }
  }

  // Herramienta exclusiva de la copia de desarrollo. Solo se activa con ?modoPrueba=1.
  // Usa el RPC real responder_objetivo con la respuesta correcta y coordenadas del objetivo actual.
  // Esto modifica el progreso y los puntos reales del proyecto Supabase configurado.
  function enableDevelopmentTestMode() {
    const enabled = new URLSearchParams(window.location.search).get("modoPrueba") === "1";
    const panel = $("#panel-prueba-desarrollo");
    if (panel) panel.hidden = !enabled;
    const button = $("#simular-objetivo-prueba");
    if (!button || !enabled) return;
    button.addEventListener("click", async () => {
      const status = $("#mensaje-prueba-desarrollo");
      const point = GAME_POINTS[currentPointIndex];
      if (!currentUser || currentProfile?.rol !== "jugador" || !currentPartidaId || !point) {
        status.textContent = "Iniciá sesión como jugador y entrá a una partida activa antes de simular.";
        return;
      }
      if (busy) {
        status.textContent = "Esperá a que termine la operación actual.";
        return;
      }
      const originalPosition = playerPosition;
      const originalValue = $("#respuesta-punto").value;
      const originalAccuracy = playerPosition?.accuracy;
      playerPosition = { latitude: point.lat, longitude: point.lng, accuracy: 5 };
      $("#respuesta-punto").value = point.answers[0];
      status.textContent = `Simulando ${point.id}…`;
      button.disabled = true;
      try {
        await submitPointAnswer({ preventDefault() {} });
        status.textContent = $("#mensaje-respuesta-punto").textContent || "Simulación ejecutada.";
      } catch (error) {
        status.textContent = explainError(error);
      } finally {
        playerPosition = originalPosition || null;
        if (playerPosition && Number.isFinite(originalAccuracy)) playerPosition.accuracy = originalAccuracy;
        $("#respuesta-punto").value = originalValue;
        if (playerPosition) {
          updatePointGpsState();
        } else {
          $("#estado-punto-gps").textContent = "Modo de prueba: usá el botón de simulación para avanzar sin GPS real.";
          $("#respuesta-punto").disabled = true;
          $("#enviar-respuesta-punto").disabled = true;
        }
        button.disabled = false;
      }
    });
  }

  function formatClock(seconds) {
    const safe = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
  }

  function stopMatchClock() {
    if (matchClockInterval !== null) window.clearInterval(matchClockInterval);
    matchClockInterval = null;
  }

  async function processMatchClosure(force = false) {
    if (!currentPartidaId || !currentUser) return false;
    const now = Date.now();
    if (!force && now - lastCloseCheckAt < 4500) return false;
    lastCloseCheckAt = now;
    try {
      const { data, error } = await db.rpc("procesar_cierre_partida", { p_partida_id: currentPartidaId });
      if (error) throw error;
      const closed = data === true;
      if (closed) {
        stopMatchClock();
        await showFinalRanking(currentPartidaId);
      }
      return closed;
    } catch (error) {
      console.warn("No se pudo comprobar el cierre de la partida:", explainError(error));
      return false;
    }
  }

  function updateClockDisplay() {
    const clock = $("#cronometro-partida");
    if (!clock || !currentMatchStartedAt || !currentMatchDurationMinutes) return;
    const endAt = new Date(currentMatchStartedAt).getTime() + currentMatchDurationMinutes * 60000;
    const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
    clock.textContent = formatClock(remaining);
    clock.classList.toggle("clock-expired", remaining === 0);
    if (remaining === 0) processMatchClosure(false);
    else processMatchClosure(false);
  }

  function startMatchClock() {
    if (!currentPartidaId || !currentUser) return;
    stopMatchClock();
    if (!currentMatchStartedAt || !currentMatchDurationMinutes) {
      db.from("partidas").select("iniciada_en, duracion_minutos, estado").eq("id", currentPartidaId).maybeSingle()
        .then(({data, error}) => {
          if (error) throw error;
          if (!data) { checkPendingRanking(); return; }
          currentMatchStartedAt = data.iniciada_en;
          currentMatchDurationMinutes = Number(data.duracion_minutos || 0);
          if (data.estado === "en_curso" && currentMatchStartedAt && currentMatchDurationMinutes > 0) {
            updateClockDisplay();
            matchClockInterval = window.setInterval(updateClockDisplay, 1000);
          } else processMatchClosure(true);
        }).catch(error => console.warn("No se pudo cargar el cronómetro:", explainError(error)));
      return;
    }
    updateClockDisplay();
    matchClockInterval = window.setInterval(updateClockDisplay, 1000);
  }

  async function checkPendingRanking() {
    if (!currentUser || currentProfile?.rol !== "jugador") return false;
    try {
      const { data, error } = await db.from("resultados_participantes")
        .select("partida_id")
        .eq("usuario_id", currentUser.id)
        .eq("continuar", false)
        .order("partida_id", { ascending: false })
        .limit(1);
      if (error) throw error;
      if (data?.length) {
        await showFinalRanking(data[0].partida_id);
        return true;
      }
    } catch (error) {
      console.warn("No se pudo comprobar si tenés un ranking pendiente:", explainError(error));
    }
    return false;
  }

  async function showFinalRanking(partidaId) {
    if (!partidaId || !currentUser) return false;
    stopMatchClock();
    currentRankingPartidaId = partidaId;
    try {
      const { data, error } = await db.rpc("obtener_ranking_final", { p_partida_id: partidaId });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) return false;
      const list = $("#lista-ranking-final");
      list.replaceChildren();
      rows.forEach(row => {
        const item = document.createElement("li");
        item.className = `ranking-item ${Number(row.puesto) === 1 ? "ranking-gold" : Number(row.puesto) === 2 ? "ranking-silver" : Number(row.puesto) === 3 ? "ranking-bronze" : "ranking-normal"}`;
        const position = document.createElement("span");
        position.className = "ranking-position";
        position.textContent = `#${row.puesto}`;
        const name = document.createElement("strong");
        name.className = "ranking-player-name";
        name.textContent = row.nombre_usuario || "Jugador";
        const points = document.createElement("span");
        points.className = "ranking-points";
        points.textContent = `${Number(row.puntos_partida || 0)} puntos`;
        const state = document.createElement("small");
        state.textContent = row.terminado ? "Tesoro completado" : "Partida finalizada por tiempo";
        item.append(position, name, points, state);
        list.append(item);
      });
      const own = rows.find(row => row.usuario_id === currentUser.id);
      $("#resumen-puntos-ranking").textContent = own
        ? `En esta partida conseguiste ${own.puntos_partida} puntos. Tu cuenta acumula ${own.puntos_totales} puntos.`
        : "Estos son los resultados finales de la partida.";
      showScreen("pantalla-ranking-final");
      return true;
    } catch (error) {
      console.error("No se pudo cargar el ranking final:", error);
      return false;
    }
  }

  async function continueFromRanking() {
    const button = $("#continuar-ranking");
    button.disabled = true;
    try {
      if (currentRankingPartidaId) {
        const { error: markError } = await db.rpc("marcar_ranking_visto", { p_partida_id: currentRankingPartidaId });
        if (markError) throw markError;
      }
      currentRankingPartidaId = null;
      currentPartidaId = null;
      currentMatchStartedAt = null;
      currentMatchDurationMinutes = null;
      showScreen("pantalla-inicio");
      if (currentUser && currentProfile?.rol === "jugador") await loadPlayerTeamStatus();
    } catch (error) {
      window.alert(`No pudimos cerrar el ranking: ${explainError(error)}`);
    } finally { button.disabled = false; }
  }

  function bindEvents() {
    $("#ir-a-registro").addEventListener("click", () => { clearMessages(); $("#form-registro").reset(); updateTutorFields(); showScreen("pantalla-registro"); });
    $("#registro-edad").addEventListener("input", updateTutorFields);
    $("#volver-a-login").addEventListener("click", () => { clearMessages(); $("#form-login").reset(); showScreen("pantalla-login"); });
    $("#form-login").addEventListener("submit", login);
    $("#form-registro").addEventListener("submit", register);
    $("#activar-gps").addEventListener("click", startGpsGame);
    $("#form-respuesta-punto").addEventListener("submit", submitPointAnswer);
    enableDevelopmentTestMode();
    $("#volver-juego-menu").addEventListener("click", () => { if(gpsWatchId!==null){navigator.geolocation.clearWatch(gpsWatchId);gpsWatchId=null;} showScreen("pantalla-menu-partidas"); });
    $("#empezar-a-jugar").addEventListener("click", async () => {
      showScreen("pantalla-menu-partidas");
      if (currentProfile?.rol === "jugador") await loadPlayerTeamStatus();
    });
    $("#actualizar-estado-equipo").addEventListener("click", loadPlayerTeamStatus);
    $("#abandonar-equipo").addEventListener("click", leaveTeam);
    const abrirJuegoGps = $("#abrir-juego-gps");
    if (abrirJuegoGps) abrirJuegoGps.addEventListener("click", async () => {
      if (currentProfile?.rol !== "jugador") {
        window.alert("Solo los jugadores pueden entrar al juego.");
        return;
      }
      if (!currentPartidaId) {
        await loadPlayerTeamStatus();
      }
      if (!currentPartidaId) {
        if (await checkPendingRanking()) return;
        window.alert("No tenés una partida en curso asignada a tu equipo.");
        return;
      }
      showScreen("pantalla-juego");
      try {
        const canPlay = await loadIndividualProgress();
        if (canPlay) startGpsGame();
      } catch (error) {
        window.alert(explainError(error));
      }
    });
    $("#ir-a-administrar-partidas").addEventListener("click", async () => {
      if (currentProfile?.rol !== "organizador") { window.alert("Solo los organizadores pueden administrar partidas."); return; }
      showScreen("pantalla-administrar-partidas");
      await loadOrganizerMatches();
    });
    $("#actualizar-partidas-organizador").addEventListener("click", loadOrganizerMatches);
    $("#ir-a-administrar-equipos").addEventListener("click", async () => {
      if (currentProfile?.rol !== "organizador") { window.alert("Solo los organizadores pueden administrar equipos."); return; }
      showScreen("pantalla-administrar-equipos");
      await loadOrganizerTeams();
    });
    $("#actualizar-equipos-organizador").addEventListener("click", loadOrganizerTeams);
    $("#volver-menu-desde-equipos").addEventListener("click", () => showScreen("pantalla-menu-partidas"));
    $("#agregar-equipo-a-partida").addEventListener("click", addTeamToSelectedMatch);
    $("#iniciar-partida").addEventListener("click", startSelectedMatch);
    $("#finalizar-partida").addEventListener("click", finishSelectedMatch);
    $("#volver-menu-desde-administrar").addEventListener("click", () => showScreen("pantalla-menu-partidas"));
    $("#ir-a-crear-partida").addEventListener("click", () => {
      if (currentProfile?.rol !== "organizador") { window.alert("Solo los organizadores pueden crear partidas."); return; }
      $("#form-crear-partida").reset();
      $("#duracion-partida").value = "60";
      $("#min-integrantes").value = "3";
      $("#max-integrantes").value = "5";
      $("#pistas-activadas").checked = true;
      $("#gps-activado").checked = true;
      $("#resultado-partida").hidden = true;
      showScreen("pantalla-crear-partida");
    });
    $("#ir-a-crear-equipo").addEventListener("click", () => {
      if (currentProfile?.rol !== "organizador") { window.alert("Solo los organizadores pueden crear equipos."); return; }
      $("#form-crear-equipo").reset();
      $("#resultado-equipo").hidden = true;
      $("#mensaje-crear-equipo").textContent = "";
      showScreen("pantalla-crear-equipo");
    });
    $("#ir-a-solicitudes-equipo").addEventListener("click", async () => {
      if (currentProfile?.rol !== "organizador") { window.alert("Solo los organizadores pueden revisar solicitudes."); return; }
      showScreen("pantalla-solicitudes-equipo");
      await loadTeamRequests();
    });
    $("#actualizar-solicitudes-equipo").addEventListener("click", loadTeamRequests);
    $("#volver-menu-desde-solicitudes").addEventListener("click", () => showScreen("pantalla-menu-partidas"));
    $("#ir-a-unirse-partida").addEventListener("click", () => { $("#form-unirse-partida").reset(); message("unirse", ""); showScreen("pantalla-unirse-partida"); });
    $("#volver-a-inicio").addEventListener("click", () => showScreen("pantalla-inicio"));
    $("#form-crear-partida").addEventListener("submit", createMatch);
    $("#form-crear-equipo").addEventListener("submit", createTeam);
    $("#form-unirse-partida").addEventListener("submit", joinMatch);
    $("#volver-menu-desde-equipo").addEventListener("click", () => showScreen("pantalla-menu-partidas"));
    $("#volver-menu-desde-crear").addEventListener("click", () => showScreen("pantalla-menu-partidas"));
    $("#volver-menu-desde-unirse").addEventListener("click", () => showScreen("pantalla-menu-partidas"));
    $("#abrir-perfil").addEventListener("click", () => showScreen("pantalla-perfil"));
    $("#cerrar-perfil").addEventListener("click", () => showScreen("pantalla-inicio"));
    $("#cerrar-sesion").addEventListener("click", logout);
    const continueRanking = $("#continuar-ranking");
    if (continueRanking) continueRanking.addEventListener("click", continueFromRanking);
  }

  async function start() {
    bindEvents();
    try {
      await loadConfig();
      const { data, error } = await db.auth.getSession();
      if (error) throw error;
      if (data.session?.user) {
        try { await openHome(data.session.user); }
        catch (error) {
          console.error("No se pudo cargar el perfil:", error);
          message("login", `No se pudo cargar tu perfil: ${explainError(error)}`, true);
          showScreen("pantalla-login");
        }
      } else showScreen("pantalla-login");

      db.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT") {
          currentUser = null;
          currentProfile = null;
          showScreen("pantalla-login");
        }
        // El inicio de sesión y la restauración de sesión navegan desde sus propios flujos.
      });
    } catch (error) {
      console.error("No se pudo iniciar la aplicación:", error);
      showScreen("pantalla-login");
      message("login", `No se pudo conectar con Supabase: ${explainError(error)}`, true);
    }
  }

  document.addEventListener("DOMContentLoaded", start, { once: true });
})();
