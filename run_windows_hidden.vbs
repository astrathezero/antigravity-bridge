Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node src\index.mjs --port 8008 --host 127.0.0.1 --enable-cors", 0, False
