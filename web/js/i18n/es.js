// ─── Diccionario español (fuente de verdad y fallback) ───────────────────────
// Para traducir a otro idioma: copia este fichero como js/i18n/<code>.js, cambia
// la línea de registro a window.I18N.<code> y traduce SOLO los valores (no las
// claves). Cualquier clave que falte o dejes sin traducir usará el español.
// Placeholders como {n}, {node}, {time} deben conservarse tal cual.

window.I18N = window.I18N || {};
window.I18N.es = {

  loading: { text: 'CARGANDO RED MESHTASTIC…' },

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
    novedades: '<strong>Nuevo</strong> — los enlaces del mapa son filtrables. Pulsa en la leyenda o usa el panel de filtros para activar o desactivar <strong>Vecino directo</strong> y <strong>Traceroute</strong>.',
  },

  cookie: {
    text: 'Esta web usa <strong>almacenamiento local</strong> para guardar tus preferencias. No se usan cookies de terceros ni datos de seguimiento.',
    accept: 'Entendido',
  },

  footer: {
    source: 'Datos extraídos de:',
    github: 'GitHub',
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

};
