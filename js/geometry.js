export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad) {
  let deg = (rad * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

export function getChordGeometry(cx, cy, radius, distance, angleDeg) {
  const d = clamp(distance, 0, radius - 3);
  const theta = degToRad(angleDeg);
  const nx = Math.cos(theta);
  const ny = Math.sin(theta);
  const ux = -Math.sin(theta);
  const uy = Math.cos(theta);

  const mx = cx + d * nx;
  const my = cy + d * ny;
  const half = Math.sqrt(Math.max(0, radius * radius - d * d));

  return {
    midpoint: { x: mx, y: my },
    p1: { x: mx - half * ux, y: my - half * uy },
    p2: { x: mx + half * ux, y: my + half * uy },
    length: 2 * half,
    distance: d,
    angle: angleDeg
  };
}

export function setLine(line, p1, p2) {
  line.setAttribute("x1", p1.x);
  line.setAttribute("y1", p1.y);
  line.setAttribute("x2", p2.x);
  line.setAttribute("y2", p2.y);
}

export function svgPoint(svg, event) {
  const pt = svg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  return pt.matrixTransform(matrix.inverse());
}

export function pointToChordState(point, center, radius) {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const distance = clamp(Math.hypot(dx, dy), 0, radius - 5);
  const angle = Math.round(radToDeg(Math.atan2(dy, dx)));
  return { distance, angle };
}

export function bindDraggableChord({
  svg, chord, midpoint, center, radius, distanceInput, angleInput, onRender
}) {
  let dragging = false;

  function update(event) {
    if (!dragging) return;
    const p = svgPoint(svg, event);
    if (!p) return;

    const next = pointToChordState(p, center, radius);
    distanceInput.value = String(Math.round(next.distance));
    angleInput.value = String(next.angle);
    onRender();
  }

  function start(event) {
    dragging = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    update(event);
  }

  function end(event) {
    dragging = false;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch (_) {}
  }

  [chord, midpoint].forEach((target) => {
    target.addEventListener("pointerdown", start);
    target.addEventListener("pointermove", update);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  });
}
