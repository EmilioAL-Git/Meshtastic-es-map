# Protobufs vendorizados

Ficheros `*_pb2.py` generados con `protoc` a partir de
[meshtastic/protobufs](https://github.com/meshtastic/protobufs), commit
`6ceceae4b121703b3575a1d2ec706f7262c94f3a`.

No se compilan en el build de Docker ni en tiempo de ejecución — están
versionados en git como cualquier dependencia vendored.

## Regenerar

```bash
git clone https://github.com/meshtastic/protobufs.git /tmp/mt-protobufs
cd /tmp/mt-protobufs
python -m pip install grpcio-tools "protobuf<6,>=5"
python -m grpc_tools.protoc -I=. --python_out=out meshtastic/*.proto
cp out/meshtastic/*.py <repo>/livefeed/proto/meshtastic/
```

Se compila el directorio `meshtastic/*.proto` completo (no solo `mqtt.proto`
+ `mesh.proto` + `portnums.proto`) porque las importaciones transitivas
(`module_config.proto` → `atak.proto`, etc.) forman un grafo enredado —
generar el conjunto completo evita `ImportError` en cascada al regenerar.

## Campo `relay_node`

`MeshPacket.relay_node` (nodo que retransmitió, últimos bytes del node id)
**sí existe** en este commit (`mesh.proto` línea ~1903). `mqtt_source.py` lo
usa cuando está presente y cae a la heurística de correlación por
`gateway_id`/`hop_limit` cuando no.
