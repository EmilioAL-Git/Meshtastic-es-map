// ─── Diccionario español (fuente de verdad y fallback) ───────────────────────
// Para traducir a otro idioma: copia este fichero como js/i18n/<code>.js, cambia
// la línea de registro a window.I18N.<code> y traduce SOLO los valores (no las
// claves). Cualquier clave que falte o dejes sin traducir usará el español.
// Placeholders como {n}, {node}, {time} deben conservarse tal cual.

window.I18N = window.I18N || {};
window.I18N.es = {

  loading: {
    text: 'CARGANDO RED MESHTASTIC…',
    warmupText: 'Todavía no hay nodos publicados — el recolector puede seguir arrancando. Reintentando automáticamente…',
  },

  header: {
    brand: 'MESHTASTIC ESPAÑA <em>/ Mapa de nodos</em>',
    nodes: 'Nodos',
    active1h: 'Activos 1h',
    gateways: 'Gateways',
    connections: 'Conexiones',
    notOptimized: 'No optimizados',
    notOptimizedCount: 'No optimizados ({n})',
    notOptimizedTitle: 'Ver nodos no optimizados',
    searchPlaceholder: 'Buscar nodo…',
    lastUpdate: 'actualizado {time}',
    live: 'En directo',
    liveTitle: 'Ver paquetes en directo',
  },

  langSelector: { title: 'Idioma / Language' },

  filters: {
    gateway: 'Gateway',
    router: 'Router',
    recent: 'Activo <1h',
    active: 'Activo <24h',
    old: 'Sin actividad',
    neighbor: 'Vecino directo',
    traceroute: 'Traceroute',
    toggleTitle: 'Filtros',
  },

  legend: {
    title: 'Leyenda',
    recent: 'Activo <1h',
    active: 'Activo <24h',
    gatewayMqtt: 'Gateway MQTT',
    routerRepeater: 'Router / Repeater',
    old: 'Sin actividad reciente',
    notOptimized: 'No optimizado',
    neighbor: 'Vecino directo',
    traceroute: 'Traceroute',
  },

  settings: {
    title: 'Ajustes del mapa',
    theme: 'Tema',
    themeLight: 'Claro',
    themeDark: 'Oscuro',
    markerSize: 'Tamaño de marcadores',
    markerSizeSmall: 'S',
    markerSizeNormal: 'M',
    markerSizeLarge: 'L',
    autoLocate: 'Auto-centrar en mi ubicación',
    autoLocateInfo: 'Al activarlo, pide permiso de ubicación al navegador y centra el mapa ahí (al activarlo y en cada carga de página). Si lo deniegas o falla, no cambia nada.',
    flyToNode: 'Volar al nodo al seleccionarlo',
    flyToNodeInfo: 'Al elegir un nodo (buscador, enlace directo…) el mapa se desplaza y hace zoom automáticamente hasta él. Desactívalo si prefieres que solo se abra el panel de detalle sin mover el mapa.',
    showPrecisionCircle: 'Círculo de precisión',
    showPrecisionCircleInfo: 'Al seleccionar un nodo, dibuja un círculo con el margen de error de su posición GPS reportada — más pequeño cuanta más precisión tenga el nodo.',
    showMalIcons: 'Iconos de no optimizados',
    showMalIconsInfo: 'Muestra un triángulo de aviso sobre los nodos con problemas de configuración detectados. Desactivarlo solo oculta el icono en el mapa: el listado "No optimizados" del header sigue funcionando igual.',
    hideOutsideSpain: 'Ocultar nodos fuera de España',
    hideOutsideSpainInfo: 'Oculta en el mapa los nodos cuya posición cae claramente fuera de España (con margen amplio, incluyendo Canarias). Es solo un filtro visual: no borra nada, y el nodo sigue apareciendo en el buscador.',
    kioskExit: '✕ Salir del modo kiosko',
  },

  zoom: { in: 'Acercar', out: 'Alejar', locate: 'Mi ubicación' },

  map: { locationError: 'No se pudo obtener tu ubicación' },

  common: { close: 'Cerrar', yes: '✓ Sí', no: 'No', dash: '—' },

  toast: {
    nodesError: '⚠ Error cargando nodos — el collector puede no haber generado los datos aún',
    apiError: '⚠ Error de conexión con la API',
    nodeNotFound: 'Nodo {node} no encontrado en la red',
    reportNotFound: 'Informe de {node} no encontrado',
    locationUnavailable: 'Ubicación no disponible para este nodo',
  },

  search: {
    noResults: 'Sin resultados',
    more: 'y {n} más — afina la búsqueda',
  },

  hint: {
    close: 'Cerrar',
    novedades: '<strong>Nuevo</strong> — pestaña <strong>En directo</strong>: sigue los paquetes de la red en tiempo real.',
  },

  cookie: {
    text: 'Esta web usa <strong>almacenamiento local</strong> para guardar tus preferencias. No se usan cookies de terceros ni datos de seguimiento.',
    accept: 'Entendido',
  },

  footer: {
    source: 'Datos extraídos de:',
    github: 'GitHub',
  },

  favorites: {
    toggle: 'Marcar/quitar como favorito',
    onlyFavorites: 'Mostrar solo paquetes de tus nodos favoritos',
    onlyFavoritesShort: 'Favoritos',
    viewList: 'Ver mis nodos favoritos',
    empty: 'Todavía no has marcado ningún nodo como favorito. Usa la ⭐ del panel de detalle o del buscador.',
  },

  // Panel de detalle del nodo (js/ui.js)
  detail: {
    id: 'ID',
    shortName: 'Nombre corto',
    hardware: 'Hardware',
    role: 'Rol',
    channel: 'Canal',
    firmware: 'Firmware',
    gatewayMqtt: 'Gateway MQTT',
    battery: 'Batería',
    voltage: 'Voltaje',
    snr: 'SNR',
    rssi: 'RSSI',
    chanUtil: 'Chan. util.',
    hops: 'Saltos',
    latitude: 'Latitud',
    longitude: 'Longitud',
    altitude: 'Altitud',
    locationPrecision: 'Precisión ubicación',
    precisionCircleValue: '{label} (círculo)',
    lastSeen: 'Último visto',
    connectionsLabel: 'Conexiones',
    agoMin: 'hace {n} min',
    agoHourMin: 'hace {h}h {m}min',
    unknown: 'desconocido',
    neighbors: { one: '{n} vecino', other: '{n} vecinos' },
    connections: { one: '{n} conexión', other: '{n} conexiones' },
    malBannerText: 'Este nodo puede estar <strong>no optimizado</strong>.',
    malBannerLink: 'Ver recomendaciones →',
    locationManualBanner: 'Posición fijada <strong>a mano</strong> por el propietario, no viene de GPS. Puede no ser exacta.',
    viewLive: 'Ver nodo en directo',
  },

  // Popup del marcador en el mapa (js/map.js)
  popup: {
    gatewayMqtt: '⚡ GATEWAY MQTT',
    hardware: 'Hardware',
    role: 'Rol',
    battery: 'Batería',
    snr: 'SNR',
    hops: 'Saltos',
    firmware: 'Firmware',
    seen: 'Visto',
    seenValue: 'hace {ago}',
    coords: 'Coords',
  },

  // Modal "Nodos no optimizados" — listado (js/malconfig.js)
  malconfig: {
    title: 'Nodos no optimizados',
    subtitle: '· Top ordenado por tráfico',
    tabList: 'Listado',
    tabStats: 'Estadísticas',
    noData: 'Sin datos disponibles',
    presetAll: 'Preset: Todos',
    presetPrefix: 'Preset: {ch}',
    ccaaAll: 'CCAA: Todas',
    issueAll: 'Problema: Todos',
    mobFixed: '📍 Fijo',
    mobMobile: '🚶 Móvil',
    mobPending: '⏳ No disponible',
    viewLink: 'Ver →',
    table: {
      rank: '#',
      name: 'Nombre',
      preset: 'Preset',
      packets: 'Paquetes',
      problems: 'Problemas detectados',
    },
    updated: {
      justNow: 'Actualizado hace un momento',
      agoMin: 'Actualizado hace {n} min',
      agoHour: 'Actualizado hace {h}h ({time})',
      atTime: 'Actualizado a las {time}',
    },
  },

  // Modal de reporte por nodo (js/malconfig.js)
  report: {
    back: '← Listado',
    title: 'Diagnóstico del nodo',
    nodeFixed: 'nodo fijo',
    nodeMobile: 'nodo móvil',
    mobilityHtml: 'Detectado como <strong>{status}</strong> — desplazamiento máximo {dist} ({checks} posiciones analizadas)',
    mobilityPendingHtml: 'Movilidad <strong>no disponible</strong> — aún no hay suficientes posiciones para determinarla ({checks} analizadas)',
    hopOkHtml: 'Hop Limit configurado: <strong>{hop}</strong> — dentro del rango recomendado',
    problemsTitle: 'Problemas detectados',
    solution: 'Solución:',
    noIssues: 'No se han detectado problemas específicos con los datos disponibles.',
    breakdownTitle: 'Desglose de paquetes (últimas 24h)',
    meshviewLink: 'Ver actividad en meshview →',
    packetsPerDay: 'paquetes/día',
    subDevice: 'Dispositivo: {n}',
    subEnvironment: 'Entorno: {n}',
    subPower: 'Eléctrica: {n}',
    auto: '⚡ Automático',
    manual: 'Manual',
    manualRequest: 'Manual/petición',
    everyMin: 'cada {n}min',
  },

  // Pestaña de estadísticas (js/malconfig.js)
  stats: {
    networkNodes: 'Nodos en la red',
    withProblems: 'Con problemas detectados',
    issueTypesTitle: 'Tipos de problema',
    issueTypesSub: '· nodos afectados',
    severityTitle: 'Severidad',
    critical: 'Crítico',
    high: 'Alto',
    medium: 'Medio',
    issuesTotal: '{n} issues en total',
    categoryTitle: 'Categoría de problema',
    byCCAA: 'Por comunidad autónoma',
    byCCAASub: '· nodos con problemas',
    evolution: 'Evolución últimos 30 días',
    evolutionSub: '· nodos con problemas detectados',
    chartEmpty1Day: 'Solo hay datos de 1 día — el gráfico aparecerá a partir del segundo día.',
    chartEmptyNoHistory: 'Sin historial disponible aún — se acumula con cada ejecución diaria.',
    groups: {
      position: 'Posición',
      telemetry: 'Telemetría',
      nodeinfo: 'NodeInfo',
      network: 'Red/Routing',
      others: 'Otros',
    },
  },

  // Tooltip del gráfico de evolución (js/malconfig.js)
  chartTip: {
    withProblems: 'con problemas',
    analyzed: '{n} analizados',
  },

  // Etiquetas cortas de tipo de problema (chips, filtros, estadísticas)
  issueLabels: {
    range_test: 'Range Test activo',
    position_fixed: 'Posición / nodo fijo',
    position_mobile: 'Posición / nodo móvil',
    position_unknown: 'Posición frecuente',
    nodeinfo: 'NodeInfo frecuente',
    telemetry_device: 'Telemetría dispositivo',
    telemetry_environment: 'Telemetría entorno',
    telemetry_power: 'Telemetría eléctrica',
    routing: 'Routing excesivo',
    traceroute_auto: 'Traceroute sistemático',
    position_flags: 'Flags GPS (fijo)',
    hop_limit_high: 'Hop limit excesivo',
    client_base_fw: 'CLIENT_BASE ≥ 2.7.17',
    client_mute_mobile: 'Móvil sin CLIENT_MUTE',
  },

  // Etiqueta larga de issue inyectada en cliente (js/app.js)
  issueLabelsLong: {
    client_base_fw: 'CLIENT_BASE ≥ 2.7.17 actúa como ROUTER_LATE',
  },

  // Etiquetas del desglose de paquetes (js/malconfig.js)
  packetLabels: {
    position: 'Posición',
    nodeinfo: 'NodeInfo',
    telemetry: 'Telemetría',
    routing: 'Routing',
    traceroute: 'Traceroute',
    text: 'Texto',
    range_test: 'Range Test',
    neighborinfo: 'Neighbor Info',
  },

  // Descripciones y soluciones de cada problema (js/malconfig.js)
  issueDefs: {
    range_test: {
      desc: 'El módulo Range Test está activo y genera tráfico innecesario. Debe desactivarse cuando no se estén realizando pruebas de cobertura.',
      fix: 'Módulos → Range Test → Desactivar',
    },
    position_fixed: {
      desc: 'Según meshtastic.es, un nodo fijo debe emitir su posición 1 vez al día (86 400 s). La posición de un nodo fijo no cambia, no tiene sentido enviarla frecuentemente.',
      fix: 'Config → Posición → Broadcast Interval → 86400',
    },
    position_mobile: {
      desc: 'Según meshtastic.es, un nodo móvil no debería emitir su posición más de 48 veces al día (mínimo cada 30 min, 1 800 s).',
      fix: 'Config → Posición → Broadcast Interval → 1800 (mínimo)',
    },
    position_unknown: {
      desc: 'El nodo emite su posición con mucha frecuencia. Según meshtastic.es: nodos fijos 1/día (86 400 s), móviles máximo 48/día (1 800 s).',
      fix: 'Config → Posición → Broadcast Interval → 86400 (fijo) o 1800 (móvil)',
    },
    nodeinfo: {
      desc: 'Según meshtastic.es, el NodeInfo debe emitirse 1 vez al día (86 400 s). La información del nodo raramente cambia.',
      fix: 'Config → Dispositivo → Node Info Broadcast Interval → 86400',
    },
    telemetry_device: {
      desc: 'Según meshtastic.es, las métricas del dispositivo (batería, voltaje, uso del canal) deben enviarse cada 12 h (43 200 s), 2 veces al día.',
      fix: 'Módulos → Telemetría del dispositivo → Intervalo → 43200',
    },
    telemetry_environment: {
      desc: 'Las métricas del entorno (temperatura, presión...) se están enviando con más frecuencia de la necesaria. 4-6 veces al día es suficiente.',
      fix: 'Módulos → Telemetría del entorno → Intervalo → aumentar',
    },
    telemetry_power: {
      desc: 'Las métricas eléctricas se están enviando con mucha frecuencia. 4-6 veces al día es suficiente salvo monitorización activa.',
      fix: 'Módulos → Telemetría eléctrica → Intervalo → aumentar',
    },
    routing: {
      desc: 'Un alto número de paquetes de routing (ACKs de protocolo) puede indicar que el módulo Store & Forward está mal configurado, o tráfico de control excesivo.',
      fix: 'Módulos → Store & Forward → desactivar si no es necesario',
    },
    position_flags: {
      desc: 'Este nodo fijo está enviando campos GPS innecesarios en sus paquetes de posición. Para nodos fijos es recomendable desactivar todas los flags/marcas. SPEED y HEADING son exclusivos de nodos móviles; NVSS_SATS, SEQ_NO, TIMESTAMP y ALT_HAE añaden datos sin valor en un nodo estático.',
      fix: 'Config → Posición → Position Flags → desactivar todos los flags',
    },
    traceroute_auto: {
      desc: 'Este nodo está generando traceroutes de forma sistemática (posiblemente una herramienta de monitorización de red). Genera tráfico considerable en la red.',
      fix: 'Configura la herramienta de monitorización (MeshSense, MeshMonitor...) para reducir la frecuencia de traceroutes o el número de nodos destino',
    },
    hop_limit_high: {
      desc: 'El nodo tiene configurado un hop_limit superior al recomendado. Un hop_limit alto provoca que cada paquete se reemita en cascada muchas más veces de lo necesario, saturando el canal y perjudicando a toda la red. Si estás en un extremo de la malla y tienes problemas de cobertura, puedes probar con 5-6, pero usa siempre el mínimo que te permita comunicarte.',
      fix: 'Config → LoRa → Hop Limit → 3 (recomendado). Si estás en el borde de la malla: prueba 5 o como máximo 6, nunca 7',
    },
    client_base_fw: {
      desc: 'A partir del firmware 2.7.17, el rol CLIENT_BASE se comporta como ROUTER_LATE: el nodo espera antes de reemitir paquetes, lo que ralentiza la propagación de mensajes en la red. Se recomienda no usar este rol.',
      fix: 'Config → Dispositivo → Rol → cambiar a CLIENT o CLIENT_MUTE si el nodo no necesita enrutar',
    },
    client_mute_mobile: {
      desc: 'Este nodo ha sido detectado como móvil pero no usa el rol CLIENT_MUTE. Un nodo móvil que retransmite paquetes ajenos genera rutas inestables y tráfico redundante al cambiar de posición.',
      fix: 'Config → Dispositivo → Rol → CLIENT_MUTE (el nodo sigue emitiendo su posición, pero deja de reenviar paquetes ajenos)',
    },
  },

  // Pestaña "En directo" (live.html / js/live.js)
  live: {
    pageTitle: 'En directo · Red Meshtastic España',
    backToMap: 'Volver al mapa',
    brand: 'MESHTASTIC ESPAÑA <em>/ En directo</em>',
    filterByType: 'Filtrar por tipo de paquete',
    filters: 'Filtrar',
    all: 'Todos',
    none: 'Ninguno',
    portnum: {
      position: 'Posición',
      text: 'Mensajes',
      telemetry: 'Telemetría',
      nodeinfo: 'Info de nodo',
      waypoint: 'Waypoint',
      traceroute: 'Traceroute',
      neighborinfo: 'Vecinos (NeighborInfo)',
      rangeTest: 'Test de alcance',
      mapReport: 'Reporte de mapa',
      encrypted: 'Cifrado (no descifrable)',
      other: 'Otros tipos',
    },
    soundAlert: 'Aviso sonoro',
    clearFocus: 'Quitar foco',
    pauseResumeFeed: 'Pausar/reanudar el feed',
    pause: 'Pausar',
    resume: 'Reanudar',
    connecting: 'Conectando…',
    connected: 'Conectado',
    reconnectingIn: 'Reconectando en {s}s…',
    packetsPerMinute: 'Paquetes por minuto en el último minuto',
    howItWorksTitle: 'Cómo funciona el directo',
    kioskEnter: 'Modo kiosko',
    packets: 'Paquetes',
    viewPackets: 'Ver paquetes',
    sessionPackets: 'Paquetes de la sesión',
    dragHandleHint: '↕ Arrastra para ajustar el tamaño',
    exportJson: 'Exportar como JSON',
    exportCsv: 'Exportar como CSV',
    waitingPackets: 'Esperando paquetes…',
    noPacketsYet: 'No hay paquetes en la sesión todavía',
    errorLoadingNodes: 'No se pudo cargar nodes.json',
    topActiveSession: 'Más activos en esta sesión',
    broadcastAll: 'Todos',
    broadcastAllFull: 'Todos (broadcast)',
    linkCopied: 'Enlace copiado',
    copyFailed: 'No se pudo copiar — usa la barra de direcciones',
    packetExpired: 'Ese paquete ya no está disponible (caducó)',
    sharedPacketError: 'No se pudo cargar el paquete compartido',
    historyLoadError: 'No se pudo cargar el histórico de ese rango',
    hopCount: { one: '{n} salto', other: '{n} saltos' },
    packetCount: { one: '{n} paquete', other: '{n} paquetes' },
    reachedCount: { one: '~{n} nodo confirmado', other: '~{n} nodos confirmados' },

    legend: {
      toggleTitle: 'Mostrar/ocultar leyenda',
      node: 'Nodo',
      focusedNode: 'Nodo enfocado',
      packetInTransit: 'Paquete en tránsito',
      packetTrail: 'Ruta trazada del paquete',
      sameHop: 'Mismo salto oído por varios gateways',
      origin: 'Origen del paquete (anillo)',
      zeroHop: 'Salto con 0 Hop',
      gatewayUpload: 'Gateway subiendo un paquete',
      exactRoute: 'Ruta exacta (traceroute real)',
      confirmedRoute: 'Ruta confirmada (relay_node real)',
      approxRoute: 'Ruta aproximada (heurística de gateways)',
    },

    timeline: {
      playPause: 'Reproducir/pausar',
      range1h: '1h',
      range12h: '12h',
      range7d: '7d',
      backToLive: 'Volver a en directo',
      live: 'En directo',
    },

    routePatterns: {
      title: 'Rutas más frecuentes',
      subtitle: 'solo saltos confirmados (traceroute o relay_node)',
      range6h: '6h',
      range24h: '24h',
      loading: 'Cargando…',
      empty: 'No hay rutas confirmadas en esta ventana de tiempo.',
      timesCount: { one: '{n} vez', other: '{n} veces' },
    },

    gatewayCompare: {
      title: 'Comparar gateways',
      vs: 'vs',
      pickBoth: 'Elige dos gateways para comparar.',
      sameNode: 'Elige dos gateways distintos.',
      empty: 'Ninguno de los dos oyó paquetes en esta ventana de tiempo.',
      only: '(solo este)',
      both: 'Ambos',
    },

    route: {
      exactShort: 'ruta exacta (traceroute)',
      confirmedShort: 'ruta confirmada',
      approxShort: 'ruta aproximada',
      exactLong: 'Ruta exacta — registrada por el propio traceroute, salto a salto real (no es una aproximación)',
      confirmedLong: 'Ruta confirmada — un salto trae relay_node y resuelve a un único nodo real conocido',
      approxLong: 'Ruta aproximada — estimada por qué gateways oyeron cada salto, sin relay_node confirmado',
    },

    hop: {
      origin: 'origen',
      destination: 'destino',
      hopN: 'salto {n}',
      unknownPosition: 'posición desconocida',
      reducedCertain: '⚡ salto reducido',
      reducedGuess: '⚡ posible salto reducido',
      reducedCertainTitle: 'Confirmado: el hop_limit no bajó en este salto (visto en los stages de gateways)',
      reducedGuessTitle: 'Inferido por el rol del nodo (ROUTER/REPEATER) — sin confirmar con hop_limit real',
      bestCandidateTitle: 'Mejor candidato entre varios nodos posibles — no confirmado',
      noHopsYet: 'Sin saltos con coordenadas conocidas todavía',
    },

    packetDetail: {
      title: 'Desglose del paquete',
      copyLink: 'Copiar enlace a este paquete',
      noData: 'Sin datos de este paquete (se ha perdido del historial).',
      packetId: 'Packet ID',
      viewOnMeshview: 'ver en meshview ↗',
      origin: 'Origen',
      destination: 'Destino',
      channel: 'Canal',
      type: 'Tipo (portnum)',
      message: 'Mensaje',
      routeConfidence: 'Confianza de ruta',
      nodesReached: 'Nodos alcanzados',
      approx: '(aprox.)',
      reachedHint: 'Cota mínima: solo cuenta nodos que son gateway MQTT (los únicos visibles desde aquí). El alcance real puede ser mayor.',
      hopsDetected: 'Saltos detectados ({n})',
      hopsHintTraceroute: '🔗 = posición conocida · ❓ = nodo real, posición desconocida · ⚡ = salto reducido (router)',
      hopsHintHeuristic: '🔗 = relay_node confirmado (único candidato) · 🔗? = mejor candidato entre varios, sin confirmar',
    },

    info: {
      title: 'Cómo funciona el visualizador de la actividad en directo',
      warnBanner: '⚠️ <strong>Esta visualización puede no ser real:</strong> solo se representan los saltos que pasan por un nodo con MQTT activado, o la ruta exacta cuando hay un traceroute disponible. El resto del camino real por radio no se ve.',
      whatH: 'Qué se ve aquí',
      whatP: 'Esta página escucha en directo el broker MQTT de la red Meshtastic España y realiza una aproximación visual sobre cómo viajan los paquetes por la red.',
      routeH: 'Cómo se reconstruye la ruta',
      routeP1: 'Un mismo paquete puede ser oído por varios gateways MQTT. Se identifica y se ordenan las apariciones por <code>hop_limit</code> descendente para aproximar el camino salto a salto.',
      routeP2: 'Si el paquete incluye pistas de qué nodo retransmitió cada salto, se marca como <strong>confirmada</strong>; si no, es una <strong>estimación</strong> basada en qué gateways oyeron cada salto. Incluso una ruta "confirmada" es nuestra mejor aproximación con los datos disponibles, no una certeza absoluta, en casos raros puede señalar al nodo equivocado.',
      routeP3: 'Solo se ve un salto cuando lo oye un nodo que <strong>además</strong> tiene el puente MQTT activado. Si un paquete pasa de un nodo normal a otro nodo normal sin que ninguno de los dos sea gateway MQTT, ese salto ocurre por radio pero nunca llega a la web: no falta información nuestra, es que no existe ningún dato que lo reporte. Por eso el desglose casi nunca muestra <em>todos</em> los saltos reales, solo los puntos donde algún gateway MQTT lo "pescó" de camino.',
      routeP4: 'Si ningún gateway MQTT oye un paquete en todo su recorrido, el paquete no aparece aquí. Aunque haya llegado bien a su destino por radio.',
      contentH: 'Qué contenido se puede leer',
      contentP1: 'Solo se decodifica lo necesario para saber el <em>tipo</em> de paquete. En canales sin contraseña propia (LongFast, MediumFast…) se puede recuperar el tipo real e incluso el texto si es un mensaje (<code>TEXT_MESSAGE_APP</code>) — es la única excepción. Un canal con PSK propia se queda como <code>ENCRYPTED</code>, sin revelar nada de su contenido.',
      contentP2: 'Un <code>TRACEROUTE_APP</code> es distinto: su contenido es en sí mismo la lista de nodos por los que pasó — metadato de enrutamiento, no un mensaje — así que cuando alguien lanza un traceroute se muestra la ruta <strong>exacta</strong> registrada por el propio firmware, no la aproximación habitual. Si algún nodo de esa lista no tiene posición conocida, se marca con "❓" en vez de dibujarlo donde no toca.',
      limitsH: 'Limitaciones',
      limit1: 'La mayoría de saltos reales no se ven: solo se registran los que pasan por un nodo con MQTT activado.',
      limit2: 'La ruta sin <code>relay_node</code> ni traceroute es aproximada, estimada por qué gateways oyeron cada salto.',
      limit3: 'En el mapa solo se dibujan los últimos 20 paquetes en vuelo a la vez.',
      limit4: 'El histórico de la línea de tiempo guarda 7 días.',
      limit5: 'Todo lo que ves aquí, incluidas las rutas "confirmadas", es una aproximación con los mejores datos disponibles, no una garantía absoluta de qué nodo participó en cada salto, es una limitación del propio protocolo Meshtastic, no de esta web.',
    },
  },

};
