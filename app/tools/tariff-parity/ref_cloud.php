<?php
/**
 * Runs Repo B's REAL App\Services\TariffCalculator against scenarios.json.
 * Meant to be run INSIDE the qparking_backend container:
 *   php /tmp/ref_cloud.php /tmp/scenarios.json
 * Builds RatePolicy + TariffRule models in-memory (no DB) and calls
 * calculateForPolicy(). Emits JSON: [{id, total_cents} | {id, error}].
 */

require '/app/vendor/autoload.php';
$app = require '/app/bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();

date_default_timezone_set('Asia/Kuala_Lumpur');
config(['app.timezone' => 'Asia/Kuala_Lumpur']);

use App\Models\RatePolicy;
use App\Models\TariffRule;
use App\Services\TariffCalculator;
use Carbon\Carbon;
use Illuminate\Support\Collection;

$path = $argv[1] ?? '/tmp/scenarios.json';
$scenarios = json_decode(file_get_contents($path), true);

$calc = new TariffCalculator();
$out = [];

foreach ($scenarios as $sc) {
    try {
        $p = $sc['policy'];
        $policy = new RatePolicy([
            'id' => 'pol-' . $sc['id'],
            'name' => $sc['id'],
            'is_active' => true,
            'grace_minutes' => $p['grace_minutes'],
            'grace_exceeded_behavior' => $p['grace_exceeded_behavior'],
            'cutoff_enabled' => $p['cutoff_enabled'],
            'cutoff_time' => $p['cutoff_time'],
            'cutoff_behavior' => $p['cutoff_behavior'],
            'first_block_once_per_entry' => $p['first_block_once_per_entry'],
            'flat_multi_rate' => $p['flat_multi_rate'],
            'rate_basis' => $p['rate_basis'],
            'new_day_fixed_fee_cents' => $p['new_day_fixed_fee_cents'],
            'daily_cap_cents' => $p['daily_cap_cents'],
        ]);

        $rules = [];
        foreach ($sc['rules'] as $i => $r) {
            // Mirror production: the calculator only ever receives ACTIVE rules
            // (loaded via ->with(['rules' => where is_active true])). Local caches
            // inactive rules but filters them in ruleMatchesAtMoment, so both
            // sides consider only active rules.
            if (isset($r['is_active']) && $r['is_active'] === false) continue;
            $rules[] = new TariffRule([
                'id' => 'rule-' . $sc['id'] . '-' . $i,
                'name' => $r['name'],
                'priority' => $r['priority'],
                'vehicle_type' => $r['vehicle_type'],
                'days_of_week' => $r['days_of_week'],
                'time_from' => $r['time_from'],
                'time_to' => $r['time_to'],
                'valid_from' => $r['valid_from'],
                'valid_to' => $r['valid_to'],
                'rule_type' => $r['rule_type'],
                'flat_amount_cents' => $r['flat_amount_cents'],
                'first_block_amount_cents' => $r['first_block_amount_cents'],
                'first_block_minutes' => $r['first_block_minutes'],
                'subsequent_block_amount_cents' => $r['subsequent_block_amount_cents'],
                'subsequent_block_minutes' => $r['subsequent_block_minutes'],
                'daily_cap_cents' => $r['daily_cap_cents'],
                'is_overnight' => $r['is_overnight'],
                'is_active' => $r['is_active'],
            ]);
        }
        $policy->setRelation('rules', new Collection($rules));

        $entry = Carbon::parse($sc['entry'])->setTimezone('Asia/Kuala_Lumpur');
        $exit  = Carbon::parse($sc['exit'])->setTimezone('Asia/Kuala_Lumpur');

        $res = $calc->calculateForPolicy($policy, $sc['vehicleType'], $entry, $exit);
        $out[] = ['id' => $sc['id'], 'total_cents' => (int) $res['total_cents']];
    } catch (\Throwable $e) {
        $out[] = ['id' => $sc['id'], 'error' => $e->getMessage()];
    }
}

echo json_encode($out, JSON_PRETTY_PRINT) . PHP_EOL;
