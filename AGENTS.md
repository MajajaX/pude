# Project Development Principles

1. Use the latest versions of frameworks and packages. Check the latest available version before adding or updating a dependency.
2. Keep the project folder structure clear. Organize files by function and responsibility, use explicit names, and avoid unnecessary nesting.
3. Write code in the simplest and clearest way possible. Express logic through clear naming and intuitive flow so it can be understood without comments, and avoid excessive abstraction or complexity.
4. Include documentation updates in the same change as every new feature or user-visible behavior change. Keep `docs/product-spec.md`, `CHANGELOG.md`, the README, and both English and Traditional Chinese website/documentation copy in sync where applicable. Cover entry points, shortcuts, settings, limits, permissions, persistence and platform differences; update screenshots and SEO metadata when affected. In the PR, list each updated surface or explain why it is not affected. Verify the documentation and website before merging or releasing.
