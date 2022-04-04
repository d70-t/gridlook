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
			const delta = Math.max(-1, Math.min(1, (e.wheelDelta || -e.detail)));

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

	Controls.addTouchHandler = function (domObject, drag, rescale) {
        var currentTouches = [];

		function touchStartHandler(e) {
            e.preventDefault();
            currentTouches = e.targetTouches;
        }

		function touchMoveHandler(e) {
            e.preventDefault();
            if (currentTouches.length != e.targetTouches.length) {
                return;
            }

            if (currentTouches.length == 1) {
                const start = currentTouches[0];
                const end = e.targetTouches[0];
                if (drag) {
                    drag((end.clientX - start.clientX) / 2, (end.clientY - start.clientY) / 2);
                }
            }

            if (currentTouches.length == 2) {
                const touchDistance = (start, end) => {
                    return Math.sqrt(Math.pow(end.clientX - start.clientX, 2) + Math.pow(end.clientY - start.clientY, 2));
                }
                const lastDistance = touchDistance(currentTouches[0], currentTouches[1]);
                const thisDistance = touchDistance(e.targetTouches[0], e.targetTouches[1]);

                const frameSize = Math.sqrt(Math.pow(domObject.width, 2) + Math.pow(domObject.height, 2));
                const scale = Math.sqrt(lastDistance / thisDistance);

                if(rescale) {
                    rescale(scale);
                }
            }

            currentTouches = e.targetTouches;
        }

		function touchEndHandler(e) {
            e.preventDefault();
            currentTouches = e.targetTouches;
        }

		function touchCancelHandler(e) {
            e.preventDefault();
            currentTouches = e.targetTouches;
        }

		domObject.addEventListener("touchstart", touchStartHandler);
		domObject.addEventListener("touchmove", touchMoveHandler);
		domObject.addEventListener("touchend", touchEndHandler);
		domObject.addEventListener("touchcancel", touchCancelHandler);
	};
	return Controls;
}(Controls || {}));

export function attachControls(renderer, camera, center, redraw) {
	function drag(deltaX, deltaY) {
		let radPerPixel = (Math.PI / 450);
        radPerPixel *= Math.min(2, camera.position.distanceTo(center) / 30);
		var deltaPhi = radPerPixel * deltaX,
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

    function rescale(scale) {
        if (camera.position.distanceTo(center) > 1.2 / scale) {
            camera.position.sub(center).multiplyScalar(scale).add(center);
            redraw();
        }
    }

	function zoomIn(delta) {
        if (camera.position.distanceTo(center) > 1.2 / 0.95) {
            camera.position.sub(center).multiplyScalar(0.95).add(center);
            redraw();
        }
	}

	function zoomOut(delta) {
		camera.position.sub(center).multiplyScalar(1.05).add(center);
		redraw();
	}

	Controls.addMouseHandler(renderer.domElement, drag, zoomIn, zoomOut);
	Controls.addTouchHandler(renderer.domElement, drag, rescale);
}
