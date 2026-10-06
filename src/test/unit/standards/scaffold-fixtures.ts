// ─── File listings of the scaffolds people actually start from ───
//
// Each listing is what the stack's own tooling (or its most common hand-made layout)
// creates before anyone writes a feature. A built-in profile is an assumption about a
// stack, so it must never stop a release over any of these.

import { StackId } from '../../../server/stacks';

export interface ScaffoldFixture {
  stack: Exclude<StackId, 'other'>;
  /** What creates this layout. */
  name: string;
  files: string[];
}

export const SCAFFOLD_FIXTURES: ScaffoldFixture[] = [
  // ── Node / TypeScript ──
  {
    stack: 'node-ts', name: 'Vite react-ts (npm create vite -- --template react-ts)',
    files: [
      'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
      'vite.config.ts', 'eslint.config.js', '.gitignore', 'README.md', 'public/vite.svg',
      'src/main.tsx', 'src/App.tsx', 'src/App.css', 'src/index.css', 'src/vite-env.d.ts', 'src/assets/react.svg',
    ],
  },
  {
    stack: 'node-ts', name: 'Create React App, TypeScript template',
    files: [
      'package.json', 'tsconfig.json', 'README.md', '.gitignore',
      'public/index.html', 'public/favicon.ico', 'public/manifest.json', 'public/robots.txt',
      'src/index.tsx', 'src/index.css', 'src/App.tsx', 'src/App.css', 'src/App.test.tsx', 'src/logo.svg',
      'src/reportWebVitals.ts', 'src/setupTests.ts', 'src/react-app-env.d.ts',
      'src/hooks/useCart.ts', 'src/hooks/useCart.test.ts',
    ],
  },
  {
    stack: 'node-ts', name: 'Next.js app router (create-next-app, no src/ directory)',
    files: [
      'package.json', 'tsconfig.json', 'next.config.ts', 'next-env.d.ts', 'postcss.config.mjs', 'eslint.config.mjs',
      'README.md', '.gitignore', 'middleware.ts',
      'app/layout.tsx', 'app/page.tsx', 'app/globals.css', 'app/favicon.ico', 'app/api/users/route.ts', 'app/dashboard/[id]/page.tsx',
      'components/NavBar.tsx', 'lib/utils.ts', 'public/next.svg', '__tests__/utils.test.ts',
    ],
  },
  {
    stack: 'node-ts', name: 'Next.js pages router',
    files: [
      'package.json', 'tsconfig.json', 'next.config.js', 'next-env.d.ts', '.eslintrc.json',
      'pages/_app.tsx', 'pages/_document.tsx', 'pages/index.tsx', 'pages/api/hello.ts', 'pages/posts/[slug].tsx',
      'styles/globals.css', 'styles/Home.module.css', 'public/favicon.ico',
    ],
  },
  {
    stack: 'node-ts', name: 'Node library (src/ and test/)',
    files: ['package.json', 'tsconfig.json', '.gitignore', 'src/index.ts', 'src/cart-total.ts', 'src/cart-total.test.ts', 'test/smoke.test.ts'],
  },

  // ── Static web ──
  {
    stack: 'static-web', name: 'css/ and js/ directories',
    files: ['index.html', 'about.html', 'css/site.css', 'js/app.js', 'images/hero.png', 'favicon.ico', 'robots.txt'],
  },
  {
    stack: 'static-web', name: 'everything at the root',
    files: ['index.html', 'style.css', 'script.js', 'README.md'],
  },
  {
    stack: 'static-web', name: 'assets/ tree',
    files: ['index.html', '404.html', 'assets/css/main.css', 'assets/js/main.js', 'assets/img/logo.svg', 'sw.js'],
  },
  {
    stack: 'static-web', name: 'src/ and public/ (bundler layout)',
    files: ['package.json', 'src/index.html', 'src/styles/main.css', 'src/scripts/main.js', 'public/robots.txt'],
  },

  // ── Python ──
  {
    stack: 'python', name: 'src layout',
    files: [
      'pyproject.toml', 'README.md', '.gitignore',
      'src/acme/__init__.py', 'src/acme/order_service.py', 'src/acme/py.typed',
      'tests/__init__.py', 'tests/conftest.py', 'tests/test_order_service.py',
    ],
  },
  {
    stack: 'python', name: 'flat layout',
    files: [
      'pyproject.toml', 'setup.py', 'requirements.txt', 'main.py',
      'acme/__init__.py', 'acme/core.py', 'acme/tests/__init__.py', 'acme/tests/test_core.py', 'tests/test_api.py',
    ],
  },
  {
    stack: 'python', name: 'Django startproject / startapp',
    files: [
      'manage.py', 'requirements.txt', 'mysite/__init__.py', 'mysite/settings.py', 'mysite/urls.py', 'mysite/wsgi.py',
      'polls/__init__.py', 'polls/models.py', 'polls/views.py', 'polls/tests.py', 'polls/migrations/0001_initial.py',
    ],
  },

  // ── Go ──
  {
    stack: 'go', name: 'cmd / internal / pkg',
    files: [
      'go.mod', 'go.sum', 'Makefile', 'README.md',
      'cmd/server/main.go', 'internal/store/store.go', 'internal/store/store_test.go', 'pkg/api/client.go',
    ],
  },
  {
    stack: 'go', name: 'go mod init with a single main package',
    files: ['go.mod', 'main.go', 'main_test.go', 'handler.go'],
  },
  {
    stack: 'go', name: 'library at the module root',
    files: ['go.mod', 'client.go', 'client_test.go', 'internal/wire/wire.go', 'examples/basic/main.go'],
  },

  // ── Java ──
  {
    stack: 'java', name: 'Maven (Spring Initializr)',
    files: [
      'pom.xml', 'mvnw', 'mvnw.cmd', '.mvn/wrapper/maven-wrapper.properties', '.gitignore',
      'src/main/java/com/acme/app/Application.java', 'src/main/resources/application.properties',
      'src/test/java/com/acme/app/ApplicationTests.java',
    ],
  },
  {
    stack: 'java', name: 'Gradle (gradle init: an app/ subproject)',
    files: [
      'settings.gradle', 'gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.properties', 'gradle/libs.versions.toml',
      'app/build.gradle', 'app/src/main/java/org/example/App.java', 'app/src/test/java/org/example/AppTest.java',
    ],
  },
  {
    stack: 'java', name: 'Gradle Kotlin DSL, single project',
    files: ['build.gradle.kts', 'settings.gradle.kts', 'src/main/java/com/acme/Main.java', 'src/test/java/com/acme/MainTest.java'],
  },

  // ── .NET ──
  {
    stack: 'dotnet', name: 'solution with src/ and tests/',
    files: [
      'App.sln', 'Directory.Build.props', '.editorconfig',
      'src/App/App.csproj', 'src/App/Program.cs', 'src/App/OrderService.cs',
      'tests/App.Tests/App.Tests.csproj', 'tests/App.Tests/OrderServiceTests.cs',
    ],
  },
  {
    stack: 'dotnet', name: 'dotnet new sln with project directories at the root',
    files: [
      'MyApp.sln', 'MyApp/MyApp.csproj', 'MyApp/Program.cs', 'MyApp/Controllers/WeatherForecastController.cs', 'MyApp/appsettings.json',
      'MyApp.Tests/MyApp.Tests.csproj', 'MyApp.Tests/UnitTest1.cs', 'MyApp.Tests/OrderServiceTests.cs',
    ],
  },
  {
    stack: 'dotnet', name: 'dotnet new console: one project at the root',
    files: ['MyApp.csproj', 'Program.cs', 'appsettings.json', 'Properties/launchSettings.json'],
  },
];
