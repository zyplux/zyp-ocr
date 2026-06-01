import { createRouter as createTanStackRouter } from '@tanstack/react-router';

import { routeTree } from '~/routeTree.gen';

export const getRouter = () =>
  createTanStackRouter({
    defaultPreload: 'intent',
    routeTree,
    scrollRestoration: true,
  });
