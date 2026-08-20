# P12 — REABIERTO: voz cross-browser

Estado: REABIERTO después del visual/product acceptance pass de iPad.

El reconocimiento de voz del navegador permanece detrás de feature detection real. Cuando `SpeechRecognition`/`webkitSpeechRecognition` no existe, Premium oculta el control de micrófono y conserva el chat textual; no simula escucha ni compatibilidad. `speechSynthesis` sólo se usa cuando tanto el sintetizador como `SpeechSynthesisUtterance` están presentes.

Pendiente para una fase posterior: diseñar y aprobar una solución de entrada de audio cross-browser. Este pass no agrega captura, upload ni backend de audio.
