@IsTest
private class LegacyTest {
    @IsTest
    static void callsLegacy() {
        Legacy.onlyTestsCallThis();
    }
}
