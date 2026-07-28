import { DefaultResourceLoader, SettingsManager, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

type ResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export type DesktopResourceLoaderOptions = {
  cwd: string;
  agentDir: string;
  projectContextEnabled: boolean;
  disabledSkills?: string[];
  extensionFactories?: ResourceLoaderOptions["extensionFactories"];
  filterExtensions(base: LoadExtensionsResult, cwd?: string): LoadExtensionsResult;
  isPluginSourceEnabled(source: string, cwd?: string): boolean;
};

export function createDesktopResourceLoader(options: DesktopResourceLoaderOptions): DefaultResourceLoader {
  const { cwd, agentDir, projectContextEnabled, disabledSkills, extensionFactories } = options;
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: projectContextEnabled }),
    noContextFiles: !projectContextEnabled,
    ...(extensionFactories ? { extensionFactories } : {}),
    extensionsOverride: (base) => options.filterExtensions(base, cwd),
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((skill) => (
        (!disabledSkills || !disabledSkills.includes(skill.name))
        && options.isPluginSourceEnabled(skill.sourceInfo.source, cwd)
      )),
    }),
    promptsOverride: (base) => ({
      ...base,
      prompts: base.prompts.filter((prompt) => options.isPluginSourceEnabled(prompt.sourceInfo.source, cwd)),
    }),
    themesOverride: (base) => ({
      ...base,
      themes: base.themes.filter((theme) => options.isPluginSourceEnabled(theme.sourceInfo?.source ?? "local", cwd)),
    }),
  });
}
