<template>
  <div class="layout">
    <nav>
      <router-link to="/">Queue</router-link>
      <router-link to="/resources">Resources</router-link>
      <router-link to="/services">Services</router-link>
    </nav>
    <main><router-view /></main>
  </div>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; background: #111; color: #eee; }
.layout { max-width: 1100px; margin: 0 auto; padding: 1rem; }
nav { display: flex; gap: 1rem; margin-bottom: 1rem; }
nav a { color: #8cf; text-decoration: none; }
nav a.router-link-active { font-weight: bold; }
table { width: 100%; border-collapse: collapse; }
td, th { border: 1px solid #333; padding: 0.35rem 0.5rem; text-align: left; }
</style>
