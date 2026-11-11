import { Directive, TemplateRef, ViewContainerRef, effect, inject, input } from '@angular/core';
import { AuthService } from '../core/auth.service';

/** Uso: <button *tienePermiso="'menor:cotizar'">Cotizar</button> */
@Directive({ selector: '[tienePermiso]' })
export class TienePermisoDirective {
  private readonly tpl = inject(TemplateRef<unknown>);
  private readonly vcr = inject(ViewContainerRef);
  private readonly auth = inject(AuthService);

  readonly tienePermiso = input.required<string>();

  constructor() {
    effect(() => {
      this.vcr.clear();
      if (this.auth.puede(this.tienePermiso())) this.vcr.createEmbeddedView(this.tpl);
    });
  }
}