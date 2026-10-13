/* Producer availability only. No subscriptions, event data, or qualification. */
#include <EndpointSecurity/EndpointSecurity.h>
#include <stdio.h>
#include <sys/sysctl.h>
#include <sys/utsname.h>
#include <unistd.h>

static const char *result_name(es_new_client_result_t result) {
    switch (result) {
    case ES_NEW_CLIENT_RESULT_SUCCESS: return "ES_NEW_CLIENT_RESULT_SUCCESS";
    case ES_NEW_CLIENT_RESULT_ERR_INVALID_ARGUMENT: return "ES_NEW_CLIENT_RESULT_ERR_INVALID_ARGUMENT";
    case ES_NEW_CLIENT_RESULT_ERR_INTERNAL: return "ES_NEW_CLIENT_RESULT_ERR_INTERNAL";
    case ES_NEW_CLIENT_RESULT_ERR_NOT_ENTITLED: return "ES_NEW_CLIENT_RESULT_ERR_NOT_ENTITLED";
    case ES_NEW_CLIENT_RESULT_ERR_NOT_PERMITTED: return "ES_NEW_CLIENT_RESULT_ERR_NOT_PERMITTED";
    case ES_NEW_CLIENT_RESULT_ERR_NOT_PRIVILEGED: return "ES_NEW_CLIENT_RESULT_ERR_NOT_PRIVILEGED";
    case ES_NEW_CLIENT_RESULT_ERR_TOO_MANY_CLIENTS: return "ES_NEW_CLIENT_RESULT_ERR_TOO_MANY_CLIENTS";
    }
    return "UNKNOWN_ES_NEW_CLIENT_RESULT";
}

int main(void) {
    char product_version[64] = "unknown";
    size_t version_size = sizeof(product_version);
    if (sysctlbyname("kern.osproductversion", product_version, &version_size, NULL, 0) != 0) {
        snprintf(product_version, sizeof(product_version), "unknown");
    }
    product_version[sizeof(product_version) - 1] = '\0';
    struct utsname kernel;
    int kernel_available = uname(&kernel) == 0;
    es_client_t *client = NULL;
    es_new_client_result_t result = es_new_client(&client, ^(es_client_t *unused_client, const es_message_t *unused_message) {
        (void)unused_client;
        (void)unused_message;
    });
    int client_created = result == ES_NEW_CLIENT_RESULT_SUCCESS && client != NULL;
    es_return_t deletion = ES_RETURN_ERROR;
    if (client_created) {
        deletion = es_delete_client(client);
    }
    printf("{\"os\":\"macOS\",\"productVersion\":\"%s\",\"kernelRelease\":\"%s\","
           "\"uid\":%lu,\"effectiveUid\":%lu,\"newClientResult\":%d,\"newClientResultName\":\"%s\","
           "\"nativeClientCreated\":%s,\"deleteClientResult\":",
           product_version, kernel_available ? kernel.release : "unknown", (unsigned long)getuid(),
           (unsigned long)geteuid(), (int)result, result_name(result), client_created ? "true" : "false");
    if (client_created) {
        printf("%d", (int)deletion);
    } else {
        printf("null");
    }
    printf(",\"subscribed\":false,\"eventsCollected\":0,\"completeProcessBirths\":false}\n");
    if (!client_created) {
        return result == ES_NEW_CLIENT_RESULT_SUCCESS ? 1 : (int)result;
    }
    return deletion == ES_RETURN_SUCCESS ? 0 : 1;
}
