#!/usr/bin/env python3
"""
Entrypoint del contenedor: fija permisos del volumen y baja a appuser.
Ejecuta como root → chown /data → setuid(appuser) → exec <script> <args>
El primer argumento es el script a arrancar (collector.py o update-top.py),
el resto se pasa tal cual.
"""
import os
import sys
import pwd

script = sys.argv[1]
script_args = sys.argv[2:]

DIRS = ['/data', '/web/data']

for dir in DIRS:
    os.makedirs(dir, exist_ok=True)

if os.getuid() == 0:
    try:
        p = pwd.getpwnam('appuser')
        # Chown recursivo: directorio y todos los ficheros existentes
        for dir in DIRS:
            for dirpath, dirnames, filenames in os.walk(dir):
                os.chown(dirpath, p.pw_uid, p.pw_gid)
                for fname in filenames:
                    os.chown(os.path.join(dirpath, fname), p.pw_uid, p.pw_gid)
        os.setgroups([])  # soltar grupos suplementarios de root
        os.setgid(p.pw_gid)
        os.setuid(p.pw_uid)
    except KeyError:
        pass  # appuser no existe, continuar como root

os.execv(sys.executable, [sys.executable, f'/app/{script}'] + script_args)
