import { Directive, ElementRef, EventEmitter, Input, NgZone, OnDestroy, OnInit, Output } from '@angular/core';
import { Observable, BehaviorSubject, from } from 'rxjs';
import { distinctUntilChanged, filter, map, shareReplay, switchMap, tap } from 'rxjs/operators';
import { RiveService } from './service';
import { Artboard, CanvasRenderer, RiveCanvas, File as RiveFile, AABB, StateMachineInstance, LinearAnimationInstance } from '@rive-app/canvas-advanced';
import { toInt } from './utils';

export type CanvasFit = 'cover' | 'contain' | 'fill' | 'fitWidth' | 'fitHeight' | 'none' | 'scaleDown';
export type CanvasAlignment = 'center' | 'topLeft' | 'topCenter' | 'topRight' | 'centerLeft' | 'centerRight' | 'bottomLeft' | 'bottomCenter' | 'bottomRight';

export type RiveOrigin = string | File | Blob | null;

const exist = <T>(v?: T | null): v is T => v !== null && v !== undefined;

const onVisible = (element: HTMLElement) => new Promise<boolean>((res, rej) => {
  // SSR
  if (typeof window === 'undefined') {
    return res(false);
  }
  // Compatibility
  if (!('IntersectionObserver' in window)) {
    return res(true);
  }
  let isVisible = false;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const visible = entry.intersectionRatio !== 0;
      if (visible !== isVisible) {
        res(isVisible);
        observer.disconnect();
      }
    });
  }, { threshold: [0] });
  // start observing element visibility
  observer.observe(element);
});


// Force event to run inside zones
export function enterZone(zone: NgZone) {
  return <T>(source: Observable<T>) =>
    new Observable<T>(observer =>
      source.subscribe({
        next: (x) => zone.run(() => observer.next(x)),
        error: (err) => observer.error(err),
        complete: () => observer.complete()
    })
   );
}

@Directive({
  selector: 'canvas[riv]',
  exportAs: 'rivCanvas'
})
export class RiveCanvasDirective implements OnInit, OnDestroy {
  private url = new BehaviorSubject<RiveOrigin>(null);
  private arboardName = new BehaviorSubject<string | null>(null);
  private _ctx?: CanvasRenderingContext2D | null;
  private loaded: Observable<boolean>;
  private boxes: Record<string, AABB> = {};
  public canvas: HTMLCanvasElement;
  public rive?: RiveCanvas;
  public file?: RiveFile; 
  public artboard?: Artboard;
  public renderer?: CanvasRenderer;

  public whenVisible: Promise<boolean>;

  @Input() set riv(url: RiveOrigin) {
    this.url.next(url);
  }

  @Input('artboard') set name(name: string) {
    this.arboardName.next(name);
  }

  @Input() viewbox = '0 0 100% 100%';
  @Input() lazy: boolean | '' = false;
  @Input() fit: CanvasFit = 'contain';
  @Input() alignment: CanvasAlignment = 'center';

  @Input()
  set width(w: number | string) {
    const width = toInt(w) ?? this.canvas.width;
    this.canvas.width = width;
  }
  get width() {
    return this.canvas.width;
  }

  @Input()
  set height(h: number | string) {
    const height = toInt(h) ?? this.canvas.height;
    this.canvas.height = height;
  }
  get height() {
    return this.canvas.height;
  }

  @Output() artboardChange = new EventEmitter<Artboard>();

  constructor(
    private service: RiveService,
    element: ElementRef<HTMLCanvasElement>
  ) {
    this.canvas = element.nativeElement;

    this.whenVisible = onVisible(element.nativeElement);

    this.loaded = this.url.pipe(
      filter(exist),
      distinctUntilChanged(),
      filter(() => typeof window !== 'undefined' && !!this.ctx),  // Make sure it's not ssr
      switchMap(async (url) => {
        this.file = await this.service.load(url);
        this.rive = this.service.rive;
        if (!this.rive) throw new Error('Service could not load rive');
        // TODO: set offscreen renderer to true for webgl
        this.renderer = this.rive.makeRenderer(this.canvas);
      }),
      switchMap(_ => this.setArtboard()),
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }


  ngOnInit() {
    this.onReady();
  }

  ngOnDestroy() {
    this.renderer?.delete();
    this.artboard?.delete();
    this.file?.delete();
  }

  get ctx(): CanvasRenderingContext2D {
    if (!this._ctx) {
      this._ctx = this.canvas.getContext('2d');
    }
    return this._ctx as CanvasRenderingContext2D;
  }

  private setArtboard() {
    return this.arboardName.pipe(
      tap(() => this.artboard?.delete()), // Remove previous artboard if any
      map(name => name ? this.file?.artboardByName(name) : this.file?.defaultArtboard()),
      tap(artboard => this.artboard = artboard),
      tap(() => this.artboardChange.emit(this.artboard)),
      map(() => true)
    );
  }

  /**
   * Calculate the box of the canvas based on viewbox, width and height
   * It memorizes the values to avoid recalculation for each frame
   */
  get box() {
    const w = this.width as number;
    const h = this.height as number;
    const boxId = `${this.viewbox} ${w} ${h}`;
    if (!this.boxes[boxId]) {
      const bounds = this.viewbox.split(' ');
      if (bounds.length !== 4) throw new Error('View box should look like "0 0 100% 100%"');
      const [minX, minY, maxX, maxY] = bounds.map((v, i) => {
        const size: number = i % 2 === 0 ? w : h;
        const percentage = v.endsWith('%')
          ? parseInt(v.slice(0, -1), 10) / 100
          : parseInt(v, 10) / size;
        return i < 2 ? -size * percentage : size / percentage;
      });
      this.boxes[boxId] = {minX, minY, maxX, maxY};
    }
    return this.boxes[boxId];
  }

  get isLazy() {
    return this.lazy === true || this.lazy === '';
  }

  get count() {
    return this.artboard?.animationCount();
  }

  onReady() {
    if (this.isLazy) {
      return from(this.whenVisible).pipe(
        filter(isVisible => isVisible),
        switchMap(() => this.loaded)
      );
    }
    return this.loaded;
  }

  draw(instance: LinearAnimationInstance, delta: number, mix: number): void
  draw(instance: StateMachineInstance, delta: number): void
  draw(instance: StateMachineInstance | LinearAnimationInstance, delta: number, mix?: number) {
    if (!this.rive) throw new Error('Could not load rive before registrating instance');
    if (!this.artboard) throw new Error('Could not load artboard before registrating instance');
    if (!this.renderer) throw new Error('Could not load renderer before registrating instance');
    
    this.renderer.clear();
    
    // Move frame
    if (isLinearAnimation(instance)) {
      instance.advance(delta);
      instance.apply(mix ?? 1);
    } else {
      instance.advance(delta);
    }
    this.artboard.advance(delta);
    
    // Render frame on canvas
    this.renderer.save();

    // Align renderer if needed
    const fit = this.rive.Fit[this.fit];
    const alignment = this.rive.Alignment[this.alignment];
    const box = this.box;
    const bounds = this.artboard.bounds;
    this.renderer.align(fit, alignment, box, bounds);

    this.artboard.draw(this.renderer);

    this.renderer.restore();
    
    // TODO: If context is WebGL Flush
    // this.renderer.flush();
  }
}

function isLinearAnimation(instance: StateMachineInstance | LinearAnimationInstance): instance is LinearAnimationInstance {
  return 'didLoop' in instance;
}