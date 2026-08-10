// ─── Diccionario galego ───────────────────────────────────────────────────────
// Strings tomados da web traducida ao galego (mesh.tuiter.ovh). Onde ese sitio
// deixaba textos sen traducir (p. ex. o buscador ou os títulos do zoom) ou con
// restos en castelán, empregouse galego correcto. As claves que falten caen a
// castelán (js/i18n/es.js).

window.I18N = window.I18N || {};
window.I18N.gl = {

  loading: { text: 'CARGANDO A REDE MESHTASTIC…' },

  header: {
    brand: 'MESHTASTIC ESPAÑA <em>/ Mapa de nodos</em>',
    nodes: 'Nodos',
    active1h: 'Activos 1 h',
    gateways: 'Gateways',
    connections: 'Conexións',
    notOptimized: 'Non optimizados',
    notOptimizedCount: 'Non optimizados ({n})',
    notOptimizedTitle: 'Ver nodos non optimizados',
    searchPlaceholder: 'Buscar un nodo…',
    lastUpdate: 'actualizado ás {time}',
  },

  langSelector: { title: 'Idioma / Language' },

  filters: {
    gateway: 'Gateway',
    router: 'Router',
    recent: 'Activo <1 h',
    active: 'Activo <24 h',
    old: 'Sen actividade',
    neighbor: 'Veciño directo',
    traceroute: 'Traceroute',
    toggleTitle: 'Filtros',
  },

  legend: {
    title: 'Lenda',
    recent: 'Activo <1 h',
    active: 'Activo <24 h',
    gatewayMqtt: 'Gateway MQTT',
    routerRepeater: 'Router / Repeater',
    old: 'Sen actividade recente',
    notOptimized: 'Non optimizado',
    neighbor: 'Veciño directo',
    traceroute: 'Traceroute',
  },

  zoom: { in: 'Achegar', out: 'Afastar', locate: 'A miña localización' },

  map: { locationError: 'Non se puido obter a túa localización' },

  common: { close: 'Pechar', yes: '✓ Si', no: 'Non', dash: '—' },

  toast: {
    nodesError: '⚠ Erro ao cargar os nodos — o collector pode aínda non ter xerado os datos',
    apiError: '⚠ Erro de conexión coa API',
    nodeNotFound: 'Nodo {node} non atopado na rede',
    reportNotFound: 'Informe de {node} non atopado',
    locationUnavailable: 'Localización non dispoñible para este nodo',
  },

  search: {
    noResults: 'Sen resultados',
    more: 'e {n} máis — afina a busca',
  },

  hint: {
    close: 'Pechar',
    novedades: '<strong>Novo</strong> — as ligazóns do mapa pódense filtrar. Preme na lenda ou usa o panel de filtros para activar ou desactivar <strong>Veciño directo</strong> e <strong>Traceroute</strong>.',
  },

  cookie: {
    text: 'Esta web usa <strong>almacenamento local</strong> para gardar as túas preferencias. Non se empregan cookies de terceiros nin datos de seguimento.',
    accept: 'Entendido',
  },

  footer: {
    source: 'Datos obtidos de:',
    github: 'GitHub',
  },

  detail: {
    id: 'ID',
    shortName: 'Nome curto',
    hardware: 'Hardware',
    role: 'Rol',
    channel: 'Canle',
    firmware: 'Firmware',
    gatewayMqtt: 'Gateway MQTT',
    battery: 'Batería',
    voltage: 'Voltaxe',
    snr: 'SNR',
    rssi: 'RSSI',
    chanUtil: 'Uso da canle',
    hops: 'Saltos',
    latitude: 'Latitude',
    longitude: 'Longitude',
    altitude: 'Altitude',
    locationPrecision: 'Precisión da localización',
    precisionCircleValue: '{label} (círculo)',
    lastSeen: 'Visto por última vez',
    connectionsLabel: 'Conexións',
    agoMin: 'hai {n} min',
    agoHourMin: 'hai {h}h {m}min',
    unknown: 'descoñecido',
    neighbors: { one: '{n} veciño', other: '{n} veciños' },
    connections: { one: '{n} conexión', other: '{n} conexións' },
    malBannerText: 'Este nodo pode <strong>non estar optimizado</strong>.',
    malBannerLink: 'Ver recomendacións →',
  },

  popup: {
    gatewayMqtt: '⚡ GATEWAY MQTT',
    hardware: 'Hardware',
    role: 'Rol',
    battery: 'Batería',
    snr: 'SNR',
    hops: 'Saltos',
    firmware: 'Firmware',
    seen: 'Visto',
    seenValue: 'hai {ago}',
    coords: 'Coords',
  },

  malconfig: {
    title: 'Nodos non optimizados',
    subtitle: '· Ordenados por tráfico',
    tabList: 'Listaxe',
    tabStats: 'Estatísticas',
    noData: 'Sen datos dispoñibles',
    presetAll: 'Preset: Todos',
    presetPrefix: 'Preset: {ch}',
    ccaaAll: 'Territorio: Todos',
    issueAll: 'Problema: Todos',
    mobFixed: '📍 Fixo',
    mobMobile: '🚶 Móbil',
    viewLink: 'Ver →',
    table: {
      rank: '#',
      name: 'Nome',
      preset: 'Preset',
      packets: 'Paquetes',
      problems: 'Problemas detectados',
    },
    updated: {
      justNow: 'Actualizado hai un momento',
      agoMin: 'Actualizado hai {n} min',
      agoHour: 'Actualizado hai {h}h ({time})',
      atTime: 'Actualizado ás {time}',
    },
  },

  report: {
    back: '← Listaxe',
    title: 'Diagnóstico do nodo',
    nodeFixed: 'nodo fixo',
    nodeMobile: 'nodo móbil',
    mobilityHtml: 'Detectado como <strong>{status}</strong> — desprazamento máximo {dist} ({checks} posicións analizadas)',
    hopOkHtml: 'Hop Limit configurado: <strong>{hop}</strong> — dentro do rango recomendado',
    problemsTitle: 'Problemas detectados',
    solution: 'Solución:',
    noIssues: 'Non se detectaron problemas específicos cos datos dispoñibles.',
    breakdownTitle: 'Detalle dos paquetes (últimas 24 h)',
    meshviewLink: 'Ver actividade en Meshview →',
    packetsPerDay: 'paquetes/día',
    subDevice: 'Dispositivo: {n}',
    subEnvironment: 'Contorna: {n}',
    subPower: 'Eléctrica: {n}',
    auto: '⚡ Automático',
    manual: 'Manual',
    manualRequest: 'Manual/solicitude',
    everyMin: 'cada {n}min',
  },

  stats: {
    networkNodes: 'Nodos na rede',
    withProblems: 'Con problemas detectados',
    issueTypesTitle: 'Tipos de problema',
    issueTypesSub: '· nodos afectados',
    severityTitle: 'Severidade',
    critical: 'Crítico',
    high: 'Alto',
    medium: 'Medio',
    issuesTotal: '{n} incidencias en total',
    categoryTitle: 'Categoría do problema',
    byCCAA: 'Por territorio',
    byCCAASub: '· nodos con problemas',
    evolution: 'Evolución dos últimos 30 días',
    evolutionSub: '· nodos con problemas detectados',
    chartEmpty1Day: 'Só hai datos dun día; o gráfico aparecerá a partir do segundo.',
    chartEmptyNoHistory: 'Aínda non hai historial dispoñible; vaise acumulando con cada execución diaria.',
    groups: {
      position: 'Posición',
      telemetry: 'Telemetría',
      nodeinfo: 'NodeInfo',
      network: 'Rede/Routing',
      others: 'Outros',
    },
  },

  chartTip: {
    withProblems: 'con problemas',
    analyzed: '{n} analizados',
  },

  issueLabels: {
    range_test: 'Range Test activo',
    position_fixed: 'Posición / nodo fixo',
    position_mobile: 'Posición / nodo móbil',
    position_unknown: 'Posición frecuente',
    nodeinfo: 'NodeInfo frecuente',
    telemetry_device: 'Telemetría do dispositivo',
    telemetry_environment: 'Telemetría da contorna',
    telemetry_power: 'Telemetría eléctrica',
    routing: 'Routing excesivo',
    traceroute_auto: 'Traceroute sistemático',
    position_flags: 'Marcas GPS (fixo)',
    hop_limit_high: 'Hop limit excesivo',
    client_base_fw: 'CLIENT_BASE ≥ 2.7.17',
    client_mute_mobile: 'Móbil sen CLIENT_MUTE',
  },

  issueLabelsLong: {
    client_base_fw: 'CLIENT_BASE ≥ 2.7.17 actúa como ROUTER_LATE',
  },

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

  issueDefs: {
    range_test: {
      desc: 'O módulo Range Test está activo e xera tráfico innecesario. Debe desactivarse cando non se estean a realizar probas de cobertura.',
      fix: 'Módulos → Range Test → Desactivar',
    },
    position_fixed: {
      desc: 'Segundo meshtastic.es, un nodo fixo debe emitir a súa posición unha vez ao día (86 400 s). A posición dun nodo fixo non cambia; non ten sentido enviala con frecuencia.',
      fix: 'Config → Posición → Broadcast Interval → 86400',
    },
    position_mobile: {
      desc: 'Segundo meshtastic.es, un nodo móbil non debería emitir a súa posición máis de 48 veces ao día (como mínimo cada 30 min, 1 800 s).',
      fix: 'Config → Posición → Broadcast Interval → 1800 (mínimo)',
    },
    position_unknown: {
      desc: 'O nodo emite a súa posición con demasiada frecuencia. Segundo meshtastic.es: nodos fixos unha vez ao día (86 400 s) e móbiles un máximo de 48 veces ao día (1 800 s).',
      fix: 'Config → Posición → Broadcast Interval → 86400 (fixo) ou 1800 (móbil)',
    },
    nodeinfo: {
      desc: 'Segundo meshtastic.es, o NodeInfo debe emitirse unha vez ao día (86 400 s). A información do nodo cambia moi poucas veces.',
      fix: 'Config → Dispositivo → Node Info Broadcast Interval → 86400',
    },
    telemetry_device: {
      desc: 'Segundo meshtastic.es, as métricas do dispositivo (batería, voltaxe e uso da canle) deben enviarse cada 12 h (43 200 s), dúas veces ao día.',
      fix: 'Módulos → Telemetría do dispositivo → Intervalo → 43200',
    },
    telemetry_environment: {
      desc: 'As métricas da contorna (temperatura, presión...) envíanse con máis frecuencia da necesaria. Entre 4 e 6 veces ao día é suficiente.',
      fix: 'Módulos → Telemetría da contorna → Intervalo → aumentar',
    },
    telemetry_power: {
      desc: 'As métricas eléctricas envíanse con demasiada frecuencia. Entre 4 e 6 veces ao día é suficiente, agás que haxa monitorización activa.',
      fix: 'Módulos → Telemetría eléctrica → Intervalo → aumentar',
    },
    routing: {
      desc: 'Un número elevado de paquetes de routing (ACKs do protocolo) pode indicar que o módulo Store & Forward está mal configurado ou que hai demasiado tráfico de control.',
      fix: 'Módulos → Store & Forward → desactivar se non é necesario',
    },
    position_flags: {
      desc: 'Este nodo fixo está a enviar campos GPS innecesarios nos seus paquetes de posición. Nos nodos fixos recoméndase desactivar todas as marcas. SPEED e HEADING son exclusivos dos nodos móbiles; NVSS_SATS, SEQ_NO, TIMESTAMP e ALT_HAE engaden datos sen valor nun nodo estático.',
      fix: 'Config → Posición → Position Flags → desactivar todas as marcas',
    },
    traceroute_auto: {
      desc: 'Este nodo está a xerar traceroutes de maneira sistemática (posiblemente unha ferramenta de monitorización de rede). Xera bastante tráfico na rede.',
      fix: 'Configura a ferramenta de monitorización (MeshSense, MeshMonitor...) para reducir a frecuencia dos traceroutes ou o número de nodos de destino',
    },
    hop_limit_high: {
      desc: 'O nodo ten configurado un hop_limit superior ao recomendado. Un hop_limit alto fai que cada paquete se retransmita en cadea moitas máis veces das necesarias, saturando a canle e prexudicando toda a rede. Se estás nun extremo da malla e tes problemas de cobertura, podes probar con 5-6, pero emprega sempre o mínimo que che permita comunicarte.',
      fix: 'Config → LoRa → Hop Limit → 3 (recomendado). Se estás no bordo da malla: proba 5 ou, como máximo, 6; nunca 7',
    },
    client_base_fw: {
      desc: 'A partir do firmware 2.7.17, o rol CLIENT_BASE compórtase como ROUTER_LATE: o nodo agarda antes de retransmitir os paquetes, o que ralentiza a propagación das mensaxes na rede. Recoméndase non empregar este rol.',
      fix: 'Config → Dispositivo → Rol → cambiar a CLIENT ou CLIENT_MUTE se o nodo non necesita encamiñar',
    },
    client_mute_mobile: {
      desc: 'Este nodo detectouse como móbil, pero non emprega o rol CLIENT_MUTE. Un nodo móbil que retransmite paquetes alleos xera rutas inestables e tráfico redundante ao cambiar de posición.',
      fix: 'Config → Dispositivo → Rol → CLIENT_MUTE (o nodo segue emitindo a súa posición, pero deixa de reenviar paquetes alleos)',
    },
  },

};
