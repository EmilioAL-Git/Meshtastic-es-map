// ─── Diccionario inglés ────────────────────────────────────────────────────
// Traducción de window.I18N.es. Cualquier clave ausente cae a español (ver
// js/i18n.js). Los placeholders {n}, {node}, {time}... se conservan tal cual.

window.I18N = window.I18N || {};
window.I18N.en = {

  loading: { text: 'LOADING MESHTASTIC NETWORK…' },

  header: {
    brand: 'MESHTASTIC SPAIN <em>/ Node map</em>',
    nodes: 'Nodes',
    active1h: 'Active 1h',
    gateways: 'Gateways',
    connections: 'Connections',
    notOptimized: 'Not optimized',
    notOptimizedCount: 'Not optimized ({n})',
    notOptimizedTitle: 'View not optimized nodes',
    searchPlaceholder: 'Search node…',
    lastUpdate: 'updated {time}',
  },

  langSelector: { title: 'Idioma / Language' },

  filters: {
    gateway: 'Gateway',
    router: 'Router',
    recent: 'Active <1h',
    active: 'Active <24h',
    old: 'No activity',
    neighbor: 'Direct neighbor',
    traceroute: 'Traceroute',
    toggleTitle: 'Filters',
  },

  legend: {
    title: 'Legend',
    recent: 'Active <1h',
    active: 'Active <24h',
    gatewayMqtt: 'MQTT Gateway',
    routerRepeater: 'Router / Repeater',
    old: 'No recent activity',
    notOptimized: 'Not optimized',
    neighbor: 'Direct neighbor',
    traceroute: 'Traceroute',
  },

  zoom: { in: 'Zoom in', out: 'Zoom out', locate: 'My location' },

  map: { locationError: 'Could not get your location' },

  common: { close: 'Close', yes: '✓ Yes', no: 'No', dash: '—' },

  toast: {
    nodesError: '⚠ Error loading nodes — the collector may not have generated data yet',
    apiError: '⚠ API connection error',
    nodeNotFound: 'Node {node} not found in the network',
    reportNotFound: 'Report for {node} not found',
    locationUnavailable: 'Location not available for this node',
  },

  search: {
    noResults: 'No results',
    more: 'and {n} more — refine your search',
  },

  hint: {
    close: 'Close',
    novedades: '<strong>New</strong> — <strong>Live</strong> tab: follow the network packets in real time.',
  },

  cookie: {
    text: 'This site uses <strong>local storage</strong> to save your preferences. No third-party cookies or tracking data are used.',
    accept: 'Got it',
  },

  footer: {
    source: 'Data sourced from:',
    github: 'GitHub',
  },

  // Panel de detalle del nodo (js/ui.js)
  detail: {
    id: 'ID',
    shortName: 'Short name',
    hardware: 'Hardware',
    role: 'Role',
    channel: 'Channel',
    firmware: 'Firmware',
    gatewayMqtt: 'MQTT Gateway',
    battery: 'Battery',
    voltage: 'Voltage',
    snr: 'SNR',
    rssi: 'RSSI',
    chanUtil: 'Chan. util.',
    hops: 'Hops',
    latitude: 'Latitude',
    longitude: 'Longitude',
    altitude: 'Altitude',
    locationPrecision: 'Location precision',
    precisionCircleValue: '{label} (circle)',
    lastSeen: 'Last seen',
    connectionsLabel: 'Connections',
    agoMin: '{n} min ago',
    agoHourMin: '{h}h {m}min ago',
    unknown: 'unknown',
    neighbors: { one: '{n} neighbor', other: '{n} neighbors' },
    connections: { one: '{n} connection', other: '{n} connections' },
    malBannerText: 'This node may be <strong>not optimized</strong>.',
    malBannerLink: 'View recommendations →',
    viewLive: 'View node live',
  },

  // Popup del marcador en el mapa (js/map.js)
  popup: {
    gatewayMqtt: '⚡ MQTT GATEWAY',
    hardware: 'Hardware',
    role: 'Role',
    battery: 'Battery',
    snr: 'SNR',
    hops: 'Hops',
    firmware: 'Firmware',
    seen: 'Seen',
    seenValue: '{ago} ago',
    coords: 'Coords',
  },

  // Modal "Nodos no optimizados" — listado (js/malconfig.js)
  malconfig: {
    title: 'Not optimized nodes',
    subtitle: '· Sorted by traffic',
    tabList: 'List',
    tabStats: 'Statistics',
    noData: 'No data available',
    presetAll: 'Preset: All',
    presetPrefix: 'Preset: {ch}',
    ccaaAll: 'Region: All',
    issueAll: 'Issue: All',
    mobFixed: '📍 Fixed',
    mobMobile: '🚶 Mobile',
    mobPending: '⏳ Not available',
    viewLink: 'View →',
    table: {
      rank: '#',
      name: 'Name',
      preset: 'Preset',
      packets: 'Packets',
      problems: 'Detected issues',
    },
    updated: {
      justNow: 'Updated just now',
      agoMin: 'Updated {n} min ago',
      agoHour: 'Updated {h}h ago ({time})',
      atTime: 'Updated at {time}',
    },
  },

  // Modal de reporte por nodo (js/malconfig.js)
  report: {
    back: '← List',
    title: 'Node diagnostics',
    nodeFixed: 'fixed node',
    nodeMobile: 'mobile node',
    mobilityHtml: 'Detected as <strong>{status}</strong> — max distance {dist} ({checks} positions analyzed)',
    mobilityPendingHtml: 'Mobility <strong>not available</strong> — not enough positions yet to determine it ({checks} analyzed)',
    hopOkHtml: 'Hop Limit configured: <strong>{hop}</strong> — within recommended range',
    problemsTitle: 'Detected issues',
    solution: 'Solution:',
    noIssues: 'No specific issues detected with the available data.',
    breakdownTitle: 'Packet breakdown (last 24h)',
    meshviewLink: 'View activity on meshview →',
    packetsPerDay: 'packets/day',
    subDevice: 'Device: {n}',
    subEnvironment: 'Environment: {n}',
    subPower: 'Power: {n}',
    auto: '⚡ Automatic',
    manual: 'Manual',
    manualRequest: 'Manual/request',
    everyMin: 'every {n}min',
  },

  // Pestaña de estadísticas (js/malconfig.js)
  stats: {
    networkNodes: 'Nodes in the network',
    withProblems: 'With detected issues',
    issueTypesTitle: 'Issue types',
    issueTypesSub: '· affected nodes',
    severityTitle: 'Severity',
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    issuesTotal: '{n} issues in total',
    categoryTitle: 'Issue category',
    byCCAA: 'By region',
    byCCAASub: '· nodes with issues',
    evolution: 'Last 30 days trend',
    evolutionSub: '· nodes with detected issues',
    chartEmpty1Day: 'Only 1 day of data available — the chart will appear from the second day on.',
    chartEmptyNoHistory: 'No history available yet — it builds up with each daily run.',
    groups: {
      position: 'Position',
      telemetry: 'Telemetry',
      nodeinfo: 'NodeInfo',
      network: 'Network/Routing',
      others: 'Others',
    },
  },

  // Tooltip del gráfico de evolución (js/malconfig.js)
  chartTip: {
    withProblems: 'with issues',
    analyzed: '{n} analyzed',
  },

  // Etiquetas cortas de tipo de problema (chips, filtros, estadísticas)
  issueLabels: {
    range_test: 'Range Test active',
    position_fixed: 'Position / fixed node',
    position_mobile: 'Position / mobile node',
    position_unknown: 'Frequent position',
    nodeinfo: 'Frequent NodeInfo',
    telemetry_device: 'Device telemetry',
    telemetry_environment: 'Environment telemetry',
    telemetry_power: 'Power telemetry',
    routing: 'Excessive routing',
    traceroute_auto: 'Systematic traceroute',
    position_flags: 'GPS flags (fixed)',
    hop_limit_high: 'Excessive hop limit',
    client_base_fw: 'CLIENT_BASE ≥ 2.7.17',
    client_mute_mobile: 'Mobile without CLIENT_MUTE',
  },

  // Etiqueta larga de issue inyectada en cliente (js/app.js)
  issueLabelsLong: {
    client_base_fw: 'CLIENT_BASE ≥ 2.7.17 acts as ROUTER_LATE',
  },

  // Etiquetas del desglose de paquetes (js/malconfig.js)
  packetLabels: {
    position: 'Position',
    nodeinfo: 'NodeInfo',
    telemetry: 'Telemetry',
    routing: 'Routing',
    traceroute: 'Traceroute',
    text: 'Text',
    range_test: 'Range Test',
    neighborinfo: 'Neighbor Info',
  },

  // Descripciones y soluciones de cada problema (js/malconfig.js)
  issueDefs: {
    range_test: {
      desc: 'The Range Test module is active and generates unnecessary traffic. It should be disabled when no coverage tests are being run.',
      fix: 'Modules → Range Test → Disable',
    },
    position_fixed: {
      desc: 'According to meshtastic.es, a fixed node should broadcast its position once a day (86,400 s). A fixed node\'s position never changes, so there is no point sending it frequently.',
      fix: 'Config → Position → Broadcast Interval → 86400',
    },
    position_mobile: {
      desc: 'According to meshtastic.es, a mobile node should not broadcast its position more than 48 times a day (at least every 30 min, 1,800 s).',
      fix: 'Config → Position → Broadcast Interval → 1800 (minimum)',
    },
    position_unknown: {
      desc: 'The node broadcasts its position very frequently. Per meshtastic.es: fixed nodes 1/day (86,400 s), mobile nodes max 48/day (1,800 s).',
      fix: 'Config → Position → Broadcast Interval → 86400 (fixed) or 1800 (mobile)',
    },
    nodeinfo: {
      desc: 'According to meshtastic.es, NodeInfo should be broadcast once a day (86,400 s). A node\'s info rarely changes.',
      fix: 'Config → Device → Node Info Broadcast Interval → 86400',
    },
    telemetry_device: {
      desc: 'According to meshtastic.es, device metrics (battery, voltage, channel utilization) should be sent every 12h (43,200 s), twice a day.',
      fix: 'Modules → Device telemetry → Interval → 43200',
    },
    telemetry_environment: {
      desc: 'Environment metrics (temperature, pressure...) are being sent more often than needed. 4-6 times a day is enough.',
      fix: 'Modules → Environment telemetry → Interval → increase',
    },
    telemetry_power: {
      desc: 'Power metrics are being sent too frequently. 4-6 times a day is enough unless active monitoring is required.',
      fix: 'Modules → Power telemetry → Interval → increase',
    },
    routing: {
      desc: 'A high number of routing packets (protocol ACKs) may indicate that the Store & Forward module is misconfigured, or excessive control traffic.',
      fix: 'Modules → Store & Forward → disable if not needed',
    },
    position_flags: {
      desc: 'This fixed node is sending unnecessary GPS fields in its position packets. For fixed nodes it is recommended to disable all flags. SPEED and HEADING are exclusive to mobile nodes; NVSS_SATS, SEQ_NO, TIMESTAMP and ALT_HAE add no value on a static node.',
      fix: 'Config → Position → Position Flags → disable all flags',
    },
    traceroute_auto: {
      desc: 'This node is systematically generating traceroutes (likely a network monitoring tool). It creates considerable traffic on the network.',
      fix: 'Configure the monitoring tool (MeshSense, MeshMonitor...) to reduce traceroute frequency or the number of destination nodes',
    },
    hop_limit_high: {
      desc: 'The node has a hop_limit higher than recommended. A high hop_limit causes every packet to be rebroadcast many more times than necessary, saturating the channel and harming the whole network. If you are at the edge of the mesh and have coverage issues, you can try 5-6, but always use the minimum that lets you communicate.',
      fix: 'Config → LoRa → Hop Limit → 3 (recommended). If you are at the edge of the mesh: try 5 or at most 6, never 7',
    },
    client_base_fw: {
      desc: 'From firmware 2.7.17 on, the CLIENT_BASE role behaves like ROUTER_LATE: the node waits before rebroadcasting packets, slowing down message propagation across the network. Using this role is not recommended.',
      fix: 'Config → Device → Role → switch to CLIENT or CLIENT_MUTE if the node does not need to route',
    },
    client_mute_mobile: {
      desc: 'This node has been detected as mobile but does not use the CLIENT_MUTE role. A mobile node that relays other nodes\' packets creates unstable routes and redundant traffic as it changes position.',
      fix: 'Config → Device → Role → CLIENT_MUTE (the node keeps broadcasting its own position, but stops relaying other nodes\' packets)',
    },
  },

};
