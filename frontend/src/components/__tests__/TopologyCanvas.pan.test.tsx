import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import TopologyCanvas from '../TopologyCanvas';
import type { Topology } from '../../types/topology';

// jsdom has no layout or 2D context; give the canvas a 1000x1000 box so
// screen→world math is 1:1 at zoom 1 (WORLD_SIZE is 1000).
beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { writable: true, configurable: true, value: ResizeObserverStub });
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, toJSON: () => ({}) }) as DOMRect;
});

afterEach(() => cleanup());

const topology: Topology = {
  id: 't1',
  name: 'test',
  // Single device far from the (100,100) click site so that spot is empty space
  devices: [{ id: 'd1', name: 'r1', type: 'router', status: 'online', x: 900, y: 900 }],
  connections: [],
  source: 'manual',
  createdAt: '',
  updatedAt: '',
};

function getCanvas(container: HTMLElement): HTMLCanvasElement {
  const canvas = container.querySelector('canvas.topology-canvas');
  if (!canvas) throw new Error('canvas not rendered');
  return canvas as HTMLCanvasElement;
}

describe('TopologyCanvas panning', () => {
  it('pan tool pans on empty-space drag, survives leaving the canvas, and translates the view', () => {
    const onEmptySpaceClick = vi.fn();
    const { container, rerender } = render(
      <TopologyCanvas topology={topology} panEnabled onEmptySpaceClick={onEmptySpaceClick} />
    );
    const canvas = getCanvas(container);

    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100, button: 0 });
    expect(onEmptySpaceClick).not.toHaveBeenCalled();
    expect(canvas.style.cursor).toBe('grabbing');

    // Pointer leaves the canvas mid-drag: pan must continue via window listeners
    fireEvent.mouseLeave(canvas);
    fireEvent.mouseMove(window, { clientX: 150, clientY: 120 });
    expect(canvas.style.cursor).toBe('grabbing');
    fireEvent.mouseUp(window, { clientX: 150, clientY: 120 });
    expect(canvas.style.cursor).toBe('grab');

    // Switch back to a tool that reports empty-space clicks: the same screen
    // point now maps 50/20 world units earlier, proving the view was panned.
    rerender(<TopologyCanvas topology={topology} onEmptySpaceClick={onEmptySpaceClick} />);
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100, button: 0 });
    expect(onEmptySpaceClick).toHaveBeenCalledTimes(1);
    expect(onEmptySpaceClick.mock.calls[0][0]).toEqual({ x: 50, y: 80 });
  });

  it('pan tool takes priority over device drag', () => {
    const onDevicePositionChange = vi.fn();
    const { container } = render(
      <TopologyCanvas topology={topology} panEnabled onDevicePositionChange={onDevicePositionChange} />
    );
    const canvas = getCanvas(container);
    fireEvent.mouseDown(canvas, { clientX: 900, clientY: 900, button: 0 });
    fireEvent.mouseMove(window, { clientX: 950, clientY: 950 });
    fireEvent.mouseUp(window, { clientX: 950, clientY: 950 });
    expect(onDevicePositionChange).not.toHaveBeenCalled();
  });

  it('select tool still marquee-selects and clears selection on empty-space click', () => {
    const onMarqueeSelect = vi.fn();
    const onEmptySpaceClick = vi.fn();
    const { container } = render(
      <TopologyCanvas topology={topology} marqueeEnabled onMarqueeSelect={onMarqueeSelect} onEmptySpaceClick={onEmptySpaceClick} />
    );
    const canvas = getCanvas(container);
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100, button: 0 });
    expect(canvas.style.cursor).toBe('crosshair');
    fireEvent.mouseUp(window, { clientX: 101, clientY: 101 });
    expect(onMarqueeSelect).toHaveBeenCalledWith(new Set());
  });

  it('middle button and Space+drag pan regardless of the active tool', () => {
    const onMarqueeSelect = vi.fn();
    const { container } = render(
      <TopologyCanvas topology={topology} marqueeEnabled onMarqueeSelect={onMarqueeSelect} />
    );
    const canvas = getCanvas(container);

    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100, button: 1 });
    expect(canvas.style.cursor).toBe('grabbing');
    fireEvent.mouseUp(window, { clientX: 100, clientY: 100, button: 1 });
    expect(onMarqueeSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { code: 'Space' });
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100, button: 0 });
    expect(canvas.style.cursor).toBe('grabbing');
    fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
    fireEvent.keyUp(window, { code: 'Space' });
    expect(onMarqueeSelect).not.toHaveBeenCalled();

    // Space typed into an input must not arm pan mode
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { code: 'Space' });
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100, button: 0 });
    expect(canvas.style.cursor).toBe('crosshair');
    fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
    input.remove();
  });
});
