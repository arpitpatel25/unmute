import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./e2e',fullyParallel:true,use:{baseURL:'http://localhost:4173',channel:'chrome',headless:true},projects:[{name:'desktop',use:{viewport:{width:1440,height:1000}}},{name:'mobile',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}],reporter:'list'});
