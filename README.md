# OCR de documentos por vídeo (fusión por zonas)

Web app en navegador que captura varios frames y construye el resultado final por `zona/campo`, sin elegir un único frame ganador global.

## Ejecutar

1. En esta carpeta, levanta un servidor estático:

```bash
python3 -m http.server 5173
```

2. Abre en el navegador:

[http://localhost:5173](http://localhost:5173)

3. Permite acceso a la cámara.

## Flujo implementado

1. Captura vídeo durante una ventana temporal (`windowMs`) con muestreo (`sampleMs`).
2. Divide el documento en zonas configurables (plantilla JSON editable en UI).
3. Evalúa calidad por zona y frame (nitidez, contraste, exposición).
4. Selecciona candidatos top `K` por cada zona (no por frame global).
5. Ejecuta OCR (Tesseract.js) solo sobre esos candidatos de cada zona.
6. Normaliza texto por tipo de campo.
7. Aplica consenso por zona (repetición + confianza OCR + calidad + validación de formato).
8. Ensambla el resultado final por piezas, guardando frame origen por campo.

## Modos

- `Guía fija`: ROI central para documento.
- `Barrido por zonas`: ROI más amplio para capturar zonas útiles mientras el usuario recorre el documento.

## Nota

Esta versión deja los campos en OCR bruto consensuado (sin parseo semántico avanzado), como pediste.
