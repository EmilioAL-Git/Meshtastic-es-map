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
    live: 'Live',
    liveTitle: 'View live packets',
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

  settings: {
    title: 'Map settings',
    theme: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    markerSize: 'Marker size',
    markerSizeSmall: 'S',
    markerSizeNormal: 'M',
    markerSizeLarge: 'L',
    autoLocate: 'Auto-center on my location',
    autoLocateInfo: 'When enabled, asks the browser for location permission and centers the map there (right away, and again on every page load). If you deny it or it fails, nothing changes.',
    flyToNode: 'Fly to node on selection',
    flyToNodeInfo: 'When you pick a node (search, direct link…) the map automatically pans and zooms to it. Turn it off if you’d rather just open the detail panel without moving the map.',
    showPrecisionCircle: 'Precision circle',
    showPrecisionCircleInfo: 'When selecting a node, draws a circle showing the margin of error of its reported GPS position — smaller the more precise the node is.',
    showMalIcons: 'Not-optimized icons',
    showMalIconsInfo: 'Shows a warning triangle over nodes with detected configuration issues. Turning it off only hides the map icon: the header’s "Not optimized" list keeps working the same.',
    kioskExit: '✕ Exit kiosk mode',
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

  // "Live" tab (live.html / js/live.js)
  live: {
    pageTitle: 'Live · Meshtastic Spain Network',
    backToMap: 'Back to map',
    brand: 'MESHTASTIC SPAIN <em>/ Live</em>',
    filterByType: 'Filter by packet type',
    filters: 'Filters',
    all: 'All',
    none: 'None',
    portnum: {
      position: 'Position',
      text: 'Messages',
      telemetry: 'Telemetry',
      nodeinfo: 'Node info',
      waypoint: 'Waypoint',
      traceroute: 'Traceroute',
      neighborinfo: 'Neighbors (NeighborInfo)',
      rangeTest: 'Range test',
      mapReport: 'Map report',
      encrypted: 'Encrypted (not decryptable)',
      other: 'Other types',
    },
    soundAlert: 'Sound alert',
    clearFocus: 'Clear focus',
    pauseResumeFeed: 'Pause/resume the feed',
    pause: 'Pause',
    resume: 'Resume',
    connecting: 'Connecting…',
    connected: 'Connected',
    reconnectingIn: 'Reconnecting in {s}s…',
    packetsPerMinute: 'Packets per minute over the last minute',
    howItWorksTitle: 'How the live view works',
    kioskEnter: 'Kiosk mode',
    packets: 'Packets',
    viewPackets: 'View packets',
    sessionPackets: 'Session packets',
    exportJson: 'Export as JSON',
    exportCsv: 'Export as CSV',
    waitingPackets: 'Waiting for packets…',
    noPacketsYet: 'No packets in the session yet',
    errorLoadingNodes: 'Could not load nodes.json',
    topActiveSession: 'Most active this session',
    broadcastAll: 'All',
    broadcastAllFull: 'All (broadcast)',
    linkCopied: 'Link copied',
    copyFailed: 'Could not copy — use the address bar',
    packetExpired: 'That packet is no longer available (expired)',
    sharedPacketError: 'Could not load the shared packet',
    historyLoadError: 'Could not load the history for that range',
    hopCount: { one: '{n} hop', other: '{n} hops' },
    packetCount: { one: '{n} packet', other: '{n} packets' },

    legend: {
      toggleTitle: 'Show/hide legend',
      node: 'Node',
      focusedNode: 'Focused node',
      packetInTransit: 'Packet in transit',
      packetTrail: 'Packet trail',
      sameHop: 'Same hop heard by several gateways',
      origin: 'Packet origin (ring)',
      zeroHop: 'Hop with 0 Hop',
      exactRoute: 'Exact route (real traceroute)',
      confirmedRoute: 'Confirmed route (real relay_node)',
      approxRoute: 'Approximate route (gateway heuristic)',
    },

    timeline: {
      playPause: 'Play/pause',
      range1h: '1h',
      range12h: '12h',
      range7d: '7d',
      backToLive: 'Back to live',
      live: 'Live',
    },

    route: {
      exactShort: 'exact route (traceroute)',
      confirmedShort: 'confirmed route',
      approxShort: 'approximate route',
      exactLong: 'Exact route — recorded by the traceroute itself, real hop by hop (not an approximation)',
      confirmedLong: 'Confirmed route — a hop carries relay_node and resolves to a single known real node',
      approxLong: 'Approximate route — estimated from which gateways heard each hop, without confirmed relay_node',
    },

    hop: {
      origin: 'origin',
      destination: 'destination',
      hopN: 'hop {n}',
      unknownPosition: 'unknown position',
      reducedCertain: '⚡ reduced hop',
      reducedGuess: '⚡ possible reduced hop',
      reducedCertainTitle: 'Confirmed: hop_limit did not drop at this hop (seen in the gateway stages)',
      reducedGuessTitle: 'Inferred from the node role (ROUTER/REPEATER) — not confirmed with a real hop_limit',
      bestCandidateTitle: 'Best candidate among several possible nodes — not confirmed',
      noHopsYet: 'No hops with known coordinates yet',
    },

    packetDetail: {
      title: 'Packet breakdown',
      copyLink: 'Copy link to this packet',
      noData: 'No data for this packet (no longer in history).',
      packetId: 'Packet ID',
      viewOnMeshview: 'view on meshview ↗',
      origin: 'Origin',
      destination: 'Destination',
      channel: 'Channel',
      type: 'Type (portnum)',
      message: 'Message',
      routeConfidence: 'Route confidence',
      nodesReached: 'Nodes reached',
      approx: '(approx.)',
      reachedHint: 'Lower bound: only counts nodes that are MQTT gateways (the only ones visible from here). The real reach may be greater.',
      hopsDetected: 'Hops detected ({n})',
      hopsHintTraceroute: '🔗 = known position · ❓ = real node, unknown position · ⚡ = reduced hop (router)',
      hopsHintHeuristic: '🔗 = confirmed relay_node (single candidate) · 🔗? = best candidate among several, unconfirmed',
    },

    info: {
      title: 'How the live activity visualizer works',
      whatH: 'What you are seeing here',
      whatP: 'This page listens live to the MQTT broker of the Meshtastic Spain network and produces a visual approximation of how packets travel across the mesh.',
      routeH: 'How the route is reconstructed',
      routeP1: 'The same packet can be heard by several MQTT gateways. Its sightings are identified and sorted by descending <code>hop_limit</code> to approximate the hop-by-hop path.',
      routeP2: 'If the packet includes clues about which node relayed each hop, it is marked as <strong>confirmed</strong>; otherwise it is an <strong>estimate</strong> based on which gateways heard each hop. Even a "confirmed" route is our best approximation with the available data, not an absolute certainty, in rare cases it may point to the wrong node.',
      routeP3: 'A hop is only visible when it is heard by a node that <strong>also</strong> has the MQTT bridge enabled. If a packet goes from one normal node to another normal node without either being an MQTT gateway, that hop happens over radio but never reaches the website: it is not missing information on our part, there is simply no data reporting it. That is why the breakdown almost never shows <em>every</em> real hop, only the points where some MQTT gateway "caught" it along the way.',
      routeP4: 'If no MQTT gateway hears a packet anywhere along its path, the packet does not appear here — even if it reached its destination fine over radio.',
      contentH: 'What content can be read',
      contentP1: 'Only what is needed to know the packet <em>type</em> is decoded. On channels without their own password (LongFast, MediumFast…) the real type — and even the text if it is a message (<code>TEXT_MESSAGE_APP</code>) — can be recovered; this is the only exception. A channel with its own PSK stays as <code>ENCRYPTED</code>, revealing nothing about its content.',
      contentP2: 'A <code>TRACEROUTE_APP</code> is different: its content is itself the list of nodes it passed through — routing metadata, not a message — so when someone launches a traceroute the <strong>exact</strong> route recorded by the firmware itself is shown, not the usual approximation. If a node in that list has no known position, it is marked with "❓" instead of being drawn somewhere it does not belong.',
      limitsH: 'Limitations',
      limit1: 'Most real hops are not visible: only the ones passing through a node with MQTT enabled are recorded.',
      limit2: 'The route without <code>relay_node</code> or traceroute is approximate, estimated from which gateways heard each hop.',
      limit3: 'The map only draws the last 20 packets in flight at a time.',
      limit4: 'The timeline history keeps 7 days.',
      limit5: 'Everything you see here, including "confirmed" routes, is an approximation based on the best available data, not an absolute guarantee of which node took part in each hop, this is a limitation of the Meshtastic protocol itself, not of this website.',
    },
  },

};
