import React, { useRef, useState, useEffect } from "react";

export default function App() {
  const [thumbs, setThumbs] = useState([]);
  const [cropped, setCropped] = useState([]);
  const [processed, setProcessed] = useState([]); // images returned from backend
  const [processing, setProcessing] = useState(false);
  const [lastCrop, setLastCrop] = useState(null); // { nx, ny, nWidth, nHeight, dataUrl }
  const [finalImage, setFinalImage] = useState(null);
  const [polygonMode, setPolygonMode] = useState(false);
  const [polygonPoints, setPolygonPoints] = useState([]); // array of {dx,dy,nx,ny}
  const [polygons, setPolygons] = useState([]); // saved polygons (multiple)
  const [maskDataUrl, setMaskDataUrl] = useState(null);
  const [selected, setSelected] = useState(null); // url

  const rightImgRef = useRef(null);
  const overlayRef = useRef(null);
  const selectionRef = useRef(null);
  const drawingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    return () => {
      // revoke object URLs on unmount
      thumbs.forEach(t => URL.revokeObjectURL(t.url));
      cropped.forEach(c => URL.revokeObjectURL(c));
    };
  }, []); // eslint-disable-line

  function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    console.log('handleFiles', files.map(f => f.name));
    const newThumbs = files.map(f => ({
      id: cryptoRandomId(),
      url: URL.createObjectURL(f),
      name: f.name
    }));
    setThumbs(prev => [...prev, ...newThumbs]);
    e.target.value = "";
  }

  function cryptoRandomId() {
    return Math.random().toString(36).slice(2, 9);
  }

  function getRelativePos(clientX, clientY, imgEl) {
    const rect = imgEl.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, clientY - rect.top)),
      rect
    };
  }

  // helper math utilities for polygon warp
  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function orderQuadPoints(pts) {
    // pts: [{x,y}] in natural coordinate space
    // sort by y, then split top/bottom, then sort by x
    const sorted = [...pts].sort((a, b) => a.y - b.y);
    const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
    const bottom = sorted.slice(2, 4).sort((a, b) => a.x - b.x);
    return [top[0], top[1], bottom[1], bottom[0]]; // TL, TR, BR, BL
  }

  function invert3x3(m) {
    // m is 3x3 array
    const a = m[0][0], b = m[0][1], c = m[0][2];
    const d = m[1][0], e = m[1][1], f = m[1][2];
    const g = m[2][0], h = m[2][1], i = m[2][2];
    const A = e * i - f * h;
    const B = c * h - b * i;
    const C = b * f - c * e;
    const D = f * g - d * i;
    const E = a * i - c * g;
    const F = c * d - a * f;
    const G = d * h - e * g;
    const H = b * g - a * h;
    const I = a * e - b * d;
    const det = a * A + b * D + c * G;
    if (Math.abs(det) < 1e-8) return null;
    const invDet = 1 / det;
    return [
      [A * invDet, B * invDet, C * invDet],
      [D * invDet, E * invDet, F * invDet],
      [G * invDet, H * invDet, I * invDet],
    ];
  }

  function multiplyMatVec(m, v) {
    return [
      m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
      m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
      m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ];
  }

  function computeAffine(srcTri, dstTri) {
    // srcTri/dstTri: [{x,y}, {x,y}, {x,y}]
    const X = [
      [srcTri[0].x, srcTri[0].y, 1],
      [srcTri[1].x, srcTri[1].y, 1],
      [srcTri[2].x, srcTri[2].y, 1],
    ];
    const invX = invert3x3(X);
    if (!invX) throw new Error("Singular matrix in affine computation");
    const U = [dstTri[0].x, dstTri[1].x, dstTri[2].x];
    const V = [dstTri[0].y, dstTri[1].y, dstTri[2].y];
    const paramsU = multiplyMatVec(invX, U); // [a, c, e]
    const paramsV = multiplyMatVec(invX, V); // [b, d, f]
    return {
      a: paramsU[0],
      c: paramsU[1],
      e: paramsU[2],
      b: paramsV[0],
      d: paramsV[1],
      f: paramsV[2],
    };
  }

  function drawTriangleToCtx(ctx, srcCanvas, srcTri, dstTri) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dstTri[0].x, dstTri[0].y);
    ctx.lineTo(dstTri[1].x, dstTri[1].y);
    ctx.lineTo(dstTri[2].x, dstTri[2].y);
    ctx.closePath();
    ctx.clip();
    const m = computeAffine(srcTri, dstTri);
    // setTransform(a, b, c, d, e, f) maps x' = a*x + c*y + e; y' = b*x + d*y + f
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(srcCanvas, 0, 0);
    ctx.restore();
    // reset transform to identity explicitly
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  async function createRectifiedCrop(quadPoints) {
    // quadPoints: [{nx,ny}] in natural pixels, any order
    if (!rightImgRef.current) throw new Error("No image");
    const ordered = orderQuadPoints(quadPoints);
    const p0 = ordered[0], p1 = ordered[1], p2 = ordered[2], p3 = ordered[3];
    const w = Math.max(dist(p0, p1), dist(p2, p3)) | 0;
    const h = Math.max(dist(p1, p2), dist(p3, p0)) | 0;
    if (w <= 0 || h <= 0) throw new Error("Invalid polygon size");

    // source canvas (original full-size)
    const origEl = rightImgRef.current;
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = origEl.naturalWidth;
    srcCanvas.height = origEl.naturalHeight;
    const sctx = srcCanvas.getContext("2d");
    sctx.drawImage(origEl, 0, 0, srcCanvas.width, srcCanvas.height);

    // destination canvas (rectified)
    const dest = document.createElement("canvas");
    dest.width = w;
    dest.height = h;
    const dctx = dest.getContext("2d");

    // triangle 1: p0,p1,p2 -> (0,0),(w,0),(w,h)
    drawTriangleToCtx(
      dctx,
      srcCanvas,
      [p0, p1, p2],
      [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }]
    );

    // triangle 2: p0,p2,p3 -> (0,0),(w,h),(0,h)
    drawTriangleToCtx(
      dctx,
      srcCanvas,
      [p0, p2, p3],
      [{ x: 0, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
    );

    return { dataUrl: dest.toDataURL("image/png"), width: w, height: h, orderedQuad: ordered };
  }

  function generateMaskFromPoints(points) {
    // points: array of {nx,ny} (natural coords)
    if (!rightImgRef.current) throw new Error("No image loaded");
    const origW = rightImgRef.current.naturalWidth;
    const origH = rightImgRef.current.naturalHeight;
    const c = document.createElement("canvas");
    c.width = origW;
    c.height = origH;
    const ctx = c.getContext("2d");
    // black background
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, origW, origH);
    // white polygon
    ctx.beginPath();
    ctx.moveTo(points[0].nx, points[0].ny);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].nx, points[i].ny);
    }
    ctx.closePath();
    ctx.fillStyle = "white";
    ctx.fill();
    return c.toDataURL("image/png");
  }

  function generateMaskFromPolygons(polys) {
    // polys: array of polygons, each polygon is array of {nx,ny}
    if (!rightImgRef.current) throw new Error("No image loaded");
    const origW = rightImgRef.current.naturalWidth;
    const origH = rightImgRef.current.naturalHeight;
    const c = document.createElement("canvas");
    c.width = origW;
    c.height = origH;
    const ctx = c.getContext("2d");
    // black background
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, origW, origH);
    // draw each polygon filled white
    ctx.fillStyle = "white";
    for (const pts of polys) {
      if (!pts || pts.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].nx, pts[0].ny);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].nx, pts[i].ny);
      ctx.closePath();
      ctx.fill();
    }
    return c.toDataURL("image/png");
  }

  function downloadDataUrl(dataUrl, filename) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function onMouseDown(e) {
    // if polygon mode active, don't start rectangular selection
    if (polygonMode) return;
    if (!rightImgRef.current) return;
    const pos = getRelativePos(e.clientX, e.clientY, rightImgRef.current);
    drawingRef.current = true;
    // store start coordinates relative to the image (not the overlay)
    startRef.current = { x: pos.x, y: pos.y };
    if (!selectionRef.current) {
      selectionRef.current = document.createElement("div");
      selectionRef.current.className = "selection";
      overlayRef.current.appendChild(selectionRef.current);
    }
    // The selection element is positioned inside the overlay (which covers the whole container),
    // but startRef is relative to the image. Compute the image offset inside the overlay so
    // the selection lines up with the image where the user clicked.
    const overlayRect = overlayRef.current.getBoundingClientRect();
    const imgRect = rightImgRef.current.getBoundingClientRect();
    const imgOffsetX = imgRect.left - overlayRect.left;
    const imgOffsetY = imgRect.top - overlayRect.top;
    selectionRef.current.style.left = imgOffsetX + startRef.current.x + "px";
    selectionRef.current.style.top = imgOffsetY + startRef.current.y + "px";
    selectionRef.current.style.width = "0px";
    selectionRef.current.style.height = "0px";
  }

  function onMouseMove(e) {
    if (!drawingRef.current || !selectionRef.current) return;
    const pos = getRelativePos(e.clientX, e.clientY, rightImgRef.current);
    const x = Math.min(startRef.current.x, pos.x);
    const y = Math.min(startRef.current.y, pos.y);
    const w = Math.abs(pos.x - startRef.current.x);
    const h = Math.abs(pos.y - startRef.current.y);
    // selection is inside overlay, so add image offset within overlay to position correctly
    const overlayRect = overlayRef.current.getBoundingClientRect();
    const imgRect = rightImgRef.current.getBoundingClientRect();
    const imgOffsetX = imgRect.left - overlayRect.left;
    const imgOffsetY = imgRect.top - overlayRect.top;
    selectionRef.current.style.left = imgOffsetX + x + "px";
    selectionRef.current.style.top = imgOffsetY + y + "px";
    selectionRef.current.style.width = w + "px";
    selectionRef.current.style.height = h + "px";
  }

  function onMouseUp() {
    drawingRef.current = false;
  }

  function clearSelection() {
    if (selectionRef.current) {
      selectionRef.current.remove();
      selectionRef.current = null;
    }
    // clear polygon points too
    setPolygonPoints([]);
    setFinalImage(null);
    setMaskDataUrl(null);
  }

  function cropSelection() {
    if (!selectionRef.current || !rightImgRef.current || !rightImgRef.current.complete) {
      alert("Make a selection first.");
      return;
    }
    const imgRect = rightImgRef.current.getBoundingClientRect();
    const selRect = selectionRef.current.getBoundingClientRect();
    const sx = selRect.left - imgRect.left;
    const sy = selRect.top - imgRect.top;
    const sw = selRect.width;
    const sh = selRect.height;
    const scaleX = rightImgRef.current.naturalWidth / imgRect.width;
    const scaleY = rightImgRef.current.naturalHeight / imgRect.height;
    const nx = Math.round(sx * scaleX);
    const ny = Math.round(sy * scaleY);
    const nWidth = Math.round(sw * scaleX);
    const nHeight = Math.round(sh * scaleY);
    if (nWidth <= 0 || nHeight <= 0) {
      alert("Invalid selection.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = nWidth;
    canvas.height = nHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(rightImgRef.current, nx, ny, nWidth, nHeight, 0, 0, nWidth, nHeight);
    const dataUrl = canvas.toDataURL("image/png");
    setCropped(prev => [...prev, dataUrl]);
    // remember crop coordinates & data for client-side compositing
    setLastCrop({ nx, ny, nWidth, nHeight, dataUrl });

    // send the cropped image to backend
    (async function sendToBackend() {
      try {
        setProcessing(true);
        // convert dataURL to blob
        function dataURLToBlob(dataURL) {
          const parts = dataURL.split(',');
          const meta = parts[0].match(/:(.*?);/);
          const contentType = meta ? meta[1] : 'image/png';
          const byteString = atob(parts[1]);
          const ia = new Uint8Array(byteString.length);
          for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
          return new Blob([ia], { type: contentType });
        }

        const blob = dataURLToBlob(dataUrl);
        const form = new FormData();
        form.append("file", blob, "crop.png");

        const res = await fetch("http://127.0.0.1:8000/process", {
          method: "POST",
          body: form
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Server error ${res.status}: ${text}`);
        }

        // FastAPI returns JSON with base64 strings:
        // { original, annotated, mask, erased } (each may be null)
        const json = await res.json().catch(() => null);
        console.log("SERVER RESPONSE: ",json);
        
        if (json) {
          const result = {
            annotated: json.annotated ? "data:image/png;base64," + json.annotated : null,
            mask: json.mask ? "data:image/png;base64," + json.mask : null,
            erased: json.erased ? "data:image/png;base64," + json.erased : null,
            original: json.original ? "data:image/png;base64," + json.original : null,
          };
          if (result.annotated || result.mask || result.erased || result.original) {
            setProcessed(result);
          } else {
            console.warn("No image fields found in /process response", json);
            alert("Server returned no processed images. Check server logs.");
          }
        } else {
          console.warn("Empty or invalid JSON from /process");
          alert("Received invalid response from server.");
        }
      } catch (err) {
        console.error("Upload/processing failed", err);
        alert("Failed to process image: " + err.message);
      } finally {
        setProcessing(false);
      }
    })();
  }

  return (
    <div className="app">
      <div className="container">
        <div className="left card">
          <h2>Upload</h2>
          <input type="file" multiple accept="image/*" onChange={handleFiles} />
          <div className="preview thumbs" aria-live="polite">
            {thumbs.map(t => (
              <img
                key={t.id}
                src={t.url}
                alt={t.name}
                className="thumb"
                onClick={() => {
                  setSelected(t.url);
                  clearSelection();
                }}
              />
            ))}
            {thumbs.length === 0 && <div className="placeholder">No images yet</div>}
          </div>
        </div>

        <div className="right card">
          <h2>Crop Area</h2>
          <div
            className="image-container"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
          >
            {selected ? (
              <>
                <img ref={rightImgRef} src={selected} alt="Selected" draggable={false} />
                <div
                  ref={overlayRef}
                  className="overlay"
                  onClick={(e) => {
                    // add polygon point when in polygon mode
                    if (!polygonMode) return;
                    if (!rightImgRef.current) return;
                    const pos = getRelativePos(e.clientX, e.clientY, rightImgRef.current);
                    const imgRect = rightImgRef.current.getBoundingClientRect();
                    const scaleX = rightImgRef.current.naturalWidth / imgRect.width;
                    const scaleY = rightImgRef.current.naturalHeight / imgRect.height;
                    const nx = pos.x * scaleX;
                    const ny = pos.y * scaleY;
                    const overlayRect = overlayRef.current.getBoundingClientRect();
                    const imgOffsetX = imgRect.left - overlayRect.left;
                    const imgOffsetY = imgRect.top - overlayRect.top;
                    const dx = imgOffsetX + pos.x;
                    const dy = imgOffsetY + pos.y;
                    setPolygonPoints(prev => {
                      const next = [...prev, { dx, dy, nx, ny }];
                      if (next.length >= 4) {
                        // save polygon and reset current points to allow creating another
                        setPolygons(ps => [...ps, { id: cryptoRandomId(), points: next }]);
                        return [];
                      }
                      return next;
                    });
                  }}
                >
                  {/* existing saved polygons */}
                  <svg className="poly-svg" width="100%" height="100%" viewBox={`0 0 ${overlayRef.current ? overlayRef.current.clientWidth : 0} ${overlayRef.current ? overlayRef.current.clientHeight : 0}`} preserveAspectRatio="none">
                    {polygons.map((poly, pi) => (
                      <g key={poly.id}>
                        <polyline
                          points={poly.points.map(p => `${p.dx},${p.dy}`).concat(`${poly.points[0].dx},${poly.points[0].dy}`).join(" ")}
                          fill="none"
                          stroke="rgba(16,185,129,0.6)"
                          strokeWidth="2"
                        />
                      </g>
                    ))}
                    {/* currently drawing polygon */}
                    {polygonPoints.length > 0 && (
                      <polyline
                        points={polygonPoints.map(p => `${p.dx},${p.dy}`).join(" ")}
                        fill="none"
                        stroke="rgba(37,99,235,0.6)"
                        strokeWidth="2"
                        strokeDasharray="6,4"
                      />
                    )}
                    {polygonPoints.length === 4 && (
                      <polyline
                        points={polygonPoints.map(p => `${p.dx},${p.dy}`).concat(`${polygonPoints[0].dx},${polygonPoints[0].dy}`).join(" ")}
                        fill="none"
                        stroke="rgba(37,99,235,0.9)"
                        strokeWidth="2"
                      />
                    )}
                  </svg>

                  {/* markers for saved polygons */}
                  {polygons.flatMap((poly, pi) =>
                    poly.points.map((p, i) => (
                      <div key={`${poly.id}-${i}`} className="poly-point" style={{ left: `${p.dx}px`, top: `${p.dy}px` }}>
                        {pi + 1}.{i + 1}
                      </div>
                    ))
                  )}
                  {/* markers for current polygon */}
                  {polygonPoints.map((p, i) => (
                    <div key={i} className="poly-point" style={{ left: `${p.dx}px`, top: `${p.dy}px` }}>
                      {i + 1}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="placeholder">Click a thumbnail to load image</div>
            )}
          </div>
          <div className="controls">
            <button onClick={cropSelection} disabled={processing || polygonMode}>
              {processing ? "Processing..." : "Crop Selection"}
            </button>
            <button onClick={clearSelection} disabled={processing}>
              Clear Selection
            </button>
            <button
              onClick={() => {
                setPolygonMode(p => !p);
                setPolygonPoints([]);
              }}
              style={{ background: polygonMode ? "#1d4ed8" : undefined }}
            >
              {polygonMode ? "Polygon: ON" : "Polygon: OFF"}
            </button>
            <button
              onClick={async () => {
                // trigger polygon crop: prefer current 4-point polygon, fall back to last saved polygon
                let sourcePoly = null;
                if (polygonPoints.length === 4) {
                  sourcePoly = polygonPoints;
                } else if (polygons.length > 0) {
                  sourcePoly = polygons[polygons.length - 1].points;
                }
                if (!sourcePoly || sourcePoly.length !== 4) {
                  alert("Place exactly 4 points on the image (or use a saved polygon).");
                  return;
                }
                try {
                  setProcessing(true);
                  const quad = sourcePoly.map(p => ({ x: p.nx, y: p.ny }));
                  const { dataUrl, width, height, orderedQuad } = await createRectifiedCrop(quad);
                  setCropped(prev => [...prev, dataUrl]);
                  setLastCrop({ polygon: orderedQuad, nWidth: width, nHeight: height, dataUrl });

                  // send to backend
                  function dataURLToBlob(dataURL) {
                    const parts = dataURL.split(',');
                    const meta = parts[0].match(/:(.*?);/);
                    const contentType = meta ? meta[1] : 'image/png';
                    const byteString = atob(parts[1]);
                    const ia = new Uint8Array(byteString.length);
                    for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
                    return new Blob([ia], { type: contentType });
                  }
                  const blob = dataURLToBlob(dataUrl);
                  const form = new FormData();
                  form.append("file", blob, "crop.png");
                  const res = await fetch("http://127.0.0.1:8000/process", {
                    method: "POST",
                    body: form
                  });
                  if (!res.ok) {
                    const text = await res.text();
                    throw new Error(`Server error ${res.status}: ${text}`);
                  }
                  const json = await res.json().catch(() => null);
                  if (json) {
                    const result = {
                      annotated: json.annotated ? "data:image/png;base64," + json.annotated : null,
                      mask: json.mask ? "data:image/png;base64," + json.mask : null,
                      erased: json.erased ? "data:image/png;base64," + json.erased : null,
                      original: json.original ? "data:image/png;base64," + json.original : null,
                    };
                    setProcessed(result);
                    setPolygonMode(false);
                  } else {
                    alert("Invalid response from server.");
                  }
                } catch (err) {
                  console.error("Polygon crop failed", err);
                  alert("Polygon crop failed: " + err.message);
                } finally {
                  setProcessing(false);
                }
              }}
              disabled={processing}
            >
              Crop Polygon
            </button>
            <button
              onClick={() => {
                // collect polygons: include current drawing (if 4) plus saved ones
                const allPolys = [...polygons.map(p => p.points)];
                if (polygonPoints.length === 4) allPolys.push(polygonPoints);
                if (allPolys.length === 0) {
                  alert("Place at least one polygon (4 points) to generate a mask.");
                  return;
                }
                try {
                  const dataUrl = generateMaskFromPolygons(allPolys);
                  setMaskDataUrl(dataUrl);
                  downloadDataUrl(dataUrl, `mask-${Date.now()}.png`);
                } catch (err) {
                  console.error("Generate mask failed", err);
                  alert("Failed to generate mask: " + err.message);
                }
              }}
              disabled={processing}
            >
              Download Mask
            </button>
            {/* saved polygons list with delete */}
            {polygons.length > 0 && (
              <div style={{ marginLeft: 12 }}>
                <strong>Saved polygons:</strong>
                <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
                  {polygons.map((poly, idx) => (
                    <li key={poly.id} style={{ marginBottom: 6 }}>
                      Polygon {idx + 1}{" "}
                      <button
                        onClick={() => {
                          setPolygons(ps => ps.filter(p => p.id !== poly.id));
                        }}
                        style={{ marginLeft: 8 }}
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="cropped-area card">
        <h3>Cropped Result</h3>
        <div id="croppedContainer">
          {cropped.map((c, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <img key={i} src={c} alt={`crop-${i}`} />
          ))}
        </div>
      </div>
      <div className="processed-area card" style={{ marginTop: 12 }}>
        <h3>Processed Results</h3>
        <div id="processedContainer">
          {processed && (processed.annotated || processed.mask || processed.erased || processed.original) ? (
            <>
              {processed.annotated && <img src={processed.annotated} alt="processed-annotated" />}
              {processed.mask && <img src={processed.mask} alt="processed-mask" />}
              {processed.erased && <img src={processed.erased} alt="processed-erased" />}
            </>
          ) : (
            <div className="placeholder">No processed images yet</div>
          )}
          {maskDataUrl && (
            <div style={{ marginTop: 8 }}>
              <h4>Mask Preview</h4>
              <img src={maskDataUrl} alt="mask-preview" style={{ maxWidth: 320 }} />
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <button
              onClick={async () => {
                // apply processed erased patch onto the original image in the browser
                if (!processed || !processed.erased) {
                  alert("No erased image available to apply.");
                  return;
                }
                if (!lastCrop || !rightImgRef.current) {
                  alert("No crop info available. Make a crop first.");
                  return;
                }
                // composite routine
                const loadImage = src =>
                  new Promise((res, rej) => {
                    const img = new Image();
                    img.crossOrigin = "anonymous";
                    img.onload = () => res(img);
                    img.onerror = rej;
                    img.src = src;
                  });

                try {
                  const origEl = rightImgRef.current;
                  const origW = origEl.naturalWidth;
                  const origH = origEl.naturalHeight;
                  const mainCanvas = document.createElement("canvas");
                  mainCanvas.width = origW;
                  mainCanvas.height = origH;
                  const mctx = mainCanvas.getContext("2d");
                  // draw original full-size
                  mctx.drawImage(origEl, 0, 0, origW, origH);

                  const erasedImg = await loadImage(processed.erased);
                  let maskImg = null;
                  if (processed.mask) {
                    maskImg = await loadImage(processed.mask);
                  }

                  // polygon-aware paste: if lastCrop.polygon exists, inverse-warp rect -> quad
                  if (lastCrop && lastCrop.polygon) {
                    const { nWidth, nHeight, polygon } = lastCrop;
                    // prepare source canvas (erased patch) and apply mask if present
                    const srcCanvasRect = document.createElement("canvas");
                    srcCanvasRect.width = nWidth;
                    srcCanvasRect.height = nHeight;
                    const sctx = srcCanvasRect.getContext("2d");
                    sctx.drawImage(erasedImg, 0, 0, nWidth, nHeight);
                    if (maskImg) {
                      sctx.globalCompositeOperation = "destination-in";
                      sctx.drawImage(maskImg, 0, 0, nWidth, nHeight);
                      sctx.globalCompositeOperation = "source-over";
                    }

                    // polygon points are in natural pixel coords (ordered)
                    const dst0 = polygon[0];
                    const dst1 = polygon[1];
                    const dst2 = polygon[2];
                    const dst3 = polygon[3];

                    // map rectangle->quad by two triangles
                    // rect tri1: (0,0),(nWidth,0),(nWidth,nHeight) -> dst0,dst1,dst2
                    drawTriangleToCtx(
                      mctx,
                      srcCanvasRect,
                      [{ x: 0, y: 0 }, { x: nWidth, y: 0 }, { x: nWidth, y: nHeight }],
                      [dst0, dst1, dst2]
                    );

                    // rect tri2: (0,0),(nWidth,nHeight),(0,nHeight) -> dst0,dst2,dst3
                    drawTriangleToCtx(
                      mctx,
                      srcCanvasRect,
                      [{ x: 0, y: 0 }, { x: nWidth, y: nHeight }, { x: 0, y: nHeight }],
                      [dst0, dst2, dst3]
                    );

                    const finalDataUrl = mainCanvas.toDataURL("image/png");
                    setFinalImage(finalDataUrl);
                  } else {
                    // axis-aligned paste (existing flow)
                    const { nx, ny, nWidth, nHeight } = lastCrop;
                    // temporary canvas for the patch
                    const tmp = document.createElement("canvas");
                    tmp.width = nWidth;
                    tmp.height = nHeight;
                    const tctx = tmp.getContext("2d");
                    // draw erased patch to tmp
                    tctx.drawImage(erasedImg, 0, 0, nWidth, nHeight);
                    if (maskImg) {
                      // apply mask: keep only where mask is white
                      tctx.globalCompositeOperation = "destination-in";
                      tctx.drawImage(maskImg, 0, 0, nWidth, nHeight);
                      tctx.globalCompositeOperation = "source-over";
                    }
                    // draw tmp onto main at the correct location
                    mctx.drawImage(tmp, nx, ny);
                    const finalDataUrl = mainCanvas.toDataURL("image/png");
                    setFinalImage(finalDataUrl);
                  }
                } catch (err) {
                  console.error("Composite failed", err);
                  alert("Failed to composite image: " + err.message);
                }
              }}
              disabled={processing}
            >
              Apply to Original
            </button>
          </div>
        </div>
      </div>
      {finalImage && (
        <div className="cropped-area card" style={{ marginTop: 12 }}>
          <h3>Final Composite</h3>
          <img src={finalImage} alt="final-composite" />
        </div>
      )}
    </div>
  );
}

