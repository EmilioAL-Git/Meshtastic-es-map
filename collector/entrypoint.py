#!/usr/bin/env python3
"""
Entrypoint del contenedor: fija permisos del volumen y baja a appuser.
Ejecuta como root → chown /data → setuid(appuser) → exec collector.py
"""
import os
import sys
import pwd

os.makedirs('/data', exist_ok=True)

if os.getuid() == 0:
    try:
        p = pwd.getpwnam('appuser')
        os.chown('/data', p.pw_uid, p.pw_gid)
        os.setgid(p.pw_gid)
        os.setuid(p.pw_uid)
    except KeyError:
        pass  # appuser no existe, continuar como root

os.execv(sys.executable, [sys.executable, '/app/collector.py'] + sys.argv[1:])
