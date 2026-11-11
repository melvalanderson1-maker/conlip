import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { Raiz } from './app/raiz.component';

bootstrapApplication(Raiz, appConfig).catch((err) => console.error(err));