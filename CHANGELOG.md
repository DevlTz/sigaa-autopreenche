# Changelog

As mudanças relevantes do projeto são registradas aqui.

## [1.3.0] - 2026-09-14

### Adicionado
- Nova interface com visual mais discreto e paleta roxo/verde.
- Seção **Reutilizar cadastro anterior**.
- Exibição do período do cadastro capturado quando disponível.
- Relatório pós-aplicação com quantidade de respostas verificadas.
- Detalhamento das perguntas que não puderam ser reaplicadas.
- Confirmação antes de substituir um cadastro anterior já capturado.
- Indicador de privacidade: dados locais e sem envio para servidor próprio.
- Nome de backup com período/data quando disponível.

### Alterado
- Backup e páginas salvas passaram a ter menor destaque visual.
- Botão de aplicação fica desabilitado quando a página atual não é um formulário compatível.

## [1.2.1] - 2026-09-14

### Corrigido
- Detecção das questões no formulário editável do SIGAA usando a estrutura `dataTableQuestionario`.
- Aplicação das respostas capturadas em componentes JSF do Cadastro Único.

## [1.2.0] - 2026-09-14

### Adicionado
- Captura de respostas de cadastros antigos em modo de visualização.
- Reaproveitamento de respostas entre períodos.
- Suporte a respostas únicas, múltiplas marcações e campo textual.

## [1.1.0] - 2026-09-14

### Alterado
- Identificação de campos mais robusta.
- Restauração em múltiplas passagens para páginas com componentes JSF/AJAX.
- Escopo da extensão limitado ao domínio do SIGAA/UFRN.

### Segurança
- Campos de senha e upload de arquivos deixaram de ser armazenados.

## [1.0.0]

### Adicionado
- Salvamento local de campos do formulário.
- Restauração automática do estado salvo.
- Exportação e importação de backup.
