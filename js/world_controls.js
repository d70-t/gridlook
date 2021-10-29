var Controls = (function(Controls) {
    "use strict";

	// Check for double inclusion
	if (Controls.addMouseHandler)
		return Controls;

	Controls.addMouseHandler = function (domObject, drag, zoomIn, zoomOut) {
		var startDragX = null,
		    startDragY = null;

		function mouseWheelHandler(e) {
			e = window.event || e;
			var delta = Math.max(-1, Math.min(1, (e.wheelDelta || -e.detail)));

			if (delta < 0 && zoomOut) {
				zoomOut(delta);
			} else if (zoomIn) {
				zoomIn(delta);
			}

			e.preventDefault();
		}

		function mouseDownHandler(e) {
			startDragX = e.clientX;
			startDragY = e.clientY;

			e.preventDefault();
		}

		function mouseMoveHandler(e) {
			if (startDragX === null || startDragY === null)
				return;

			if (drag)
				drag(e.clientX - startDragX, e.clientY - startDragY);

			startDragX = e.clientX;
			startDragY = e.clientY;

			e.preventDefault();
		}

		function mouseUpHandler(e) {
			mouseMoveHandler.call(this, e);
			startDragX = null;
			startDragY = null;

			e.preventDefault();
		}

		domObject.addEventListener("mousewheel", mouseWheelHandler);
		domObject.addEventListener("DOMMouseScroll", mouseWheelHandler);
		domObject.addEventListener("mousedown", mouseDownHandler);
		domObject.addEventListener("mousemove", mouseMoveHandler);
		domObject.addEventListener("mouseup", mouseUpHandler);
	};
	return Controls;
}(Controls || {}));

function attachControls(renderer, camera, center, redraw) {
	function drag(deltaX, deltaY) {
		var radPerPixel = (Math.PI / 450),
		    deltaPhi = radPerPixel * deltaX,
		    deltaTheta = radPerPixel * deltaY,
		    pos = camera.position.sub(center),
		    radius = pos.length(),
		    theta = Math.acos(pos.z / radius),
		    phi = Math.atan2(pos.y, pos.x);

		// Subtract deltaTheta and deltaPhi
		theta = Math.min(Math.max(theta - deltaTheta, 0), Math.PI);
		phi -= deltaPhi;

		// Turn back into Cartesian coordinates
		pos.x = radius * Math.sin(theta) * Math.cos(phi);
		pos.y = radius * Math.sin(theta) * Math.sin(phi);
		pos.z = radius * Math.cos(theta);

		camera.position.add(center);
		camera.lookAt(center);
		redraw();
	}

	function zoomIn() {
		camera.position.sub(center).multiplyScalar(0.95).add(center);
		redraw();
	}

	function zoomOut() {
		camera.position.sub(center).multiplyScalar(1.05).add(center);
		redraw();
	}

	Controls.addMouseHandler(renderer.domElement, drag, zoomIn, zoomOut);
}
